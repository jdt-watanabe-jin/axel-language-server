import * as assert from 'assert';
import type { CompletionItem, Hover, SignatureHelp, MarkupContent } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';
import { positionFromOffset } from '../support/source';

suite('Doxygen LSP', function () {
  this.timeout(20_000);
  for (const [markdown, locale] of [[true, 'ja-JP'], [false, 'en']] as const) {
    test(`transfers hover completion and parameter descriptions with markdown=${markdown}, locale=${locale}`, async () => {
      const server = startLspServer();
      try {
        await server.request('initialize', {processId:null,rootUri:null,locale,capabilities:markdown ? {
          textDocument:{hover:{contentFormat:['markdown']},completion:{completionItem:{documentationFormat:['markdown']}},
            signatureHelp:{signatureInformation:{documentationFormat:['markdown']}}}
        } : {}});
        await server.notify('initialized', {});
        const uri = 'file:///doxygen/main.axl';
        const text = '/*! @brief Search files\n * @param[in] n Count\n * @retval 1 Success\n */\nint Find(int n);\nvoid main(){ Find(1); }';
        await server.notify('textDocument/didOpen',{textDocument:{uri,languageId:'axel',version:1,text}});
        const hover = await server.request<Hover>('textDocument/hover',{textDocument:{uri},position:positionFromOffset(text,text.lastIndexOf('Find'))});
        const content = hover.contents as MarkupContent;
        assert.strictEqual(content.kind,markdown ? 'markdown':'plaintext');
        assert.ok(content.value.includes('Search files'));
        assert.ok(!content.value.includes('@brief'));
        assert.ok(content.value.includes(locale === 'en' ? 'Parameters' : '\u5f15\u6570'));
        const help = await server.request<SignatureHelp>('textDocument/signatureHelp',{textDocument:{uri},position:positionFromOffset(text,text.lastIndexOf('1'))});
        const parameter = help.signatures[0].parameters![0].documentation!;
        assert.ok(JSON.stringify(parameter).includes('Count'));
        assert.strictEqual(typeof parameter,markdown ? 'object':'string');
        const items = await server.request<CompletionItem[]>('textDocument/completion',{textDocument:{uri},position:positionFromOffset(text,text.lastIndexOf('Find')+2)});
        const item = items.find(i=>i.label==='Find')!;
        assert.ok(JSON.stringify(item.documentation).includes('Search files'));
        assert.strictEqual(typeof item.documentation,markdown ? 'object':'string');
        if (markdown) {
          const changed = text.replace('Search files','Updated description');
          await server.notify('textDocument/didChange',{textDocument:{uri,version:2},contentChanges:[{text:changed}]});
          const updated = await server.request<Hover>('textDocument/hover',{textDocument:{uri},position:positionFromOffset(changed,changed.lastIndexOf('Find'))});
          assert.ok((updated.contents as MarkupContent).value.includes('Updated description'));
          assert.ok(!(updated.contents as MarkupContent).value.includes('Search files'));
          const removed = 'int Find(int n);\nvoid main(){ Find(1); }';
          await server.notify('textDocument/didChange',{textDocument:{uri,version:3},contentChanges:[{text:removed}]});
          const withoutDocs = await server.request<Hover>('textDocument/hover',{textDocument:{uri},position:positionFromOffset(removed,removed.lastIndexOf('Find'))});
          assert.ok(!(withoutDocs.contents as MarkupContent).value.includes('Updated description'));
          const incomplete = '/*! @brief Incomplete\n' + removed;
          await server.notify('textDocument/didChange',{textDocument:{uri,version:4},contentChanges:[{text:incomplete}]});
          const unfinished = await server.request<Hover | null>('textDocument/hover',{textDocument:{uri},position:positionFromOffset(incomplete,incomplete.lastIndexOf('Find'))});
          assert.ok(!JSON.stringify(unfinished).includes('Updated description'));
        }

      } finally { await server.stop(); }
    });
  }
});
