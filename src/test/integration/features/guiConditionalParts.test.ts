import * as assert from 'assert';
import { useWorkspaceFixtures } from '../../support/workspace';
import type { AnalysisGuiPart } from '../../../types/analysis';

suite('Conditional GUI parts', () => {
  const fixtures = useWorkspaceFixtures();
  function names(parts: AnalysisGuiPart[]): string[] {
    return parts.flatMap(p => [...(p.name ? [p.name] : []), ...names(p.parts)]);
  }
  const text = `class D : GCDialog { GCHBoxLayout {
#if __APP_LEDIT__
GCCheckBox chk_toponly { OnCreate() {} };
#else
GCCheckBox other;
#endif
}; };
#if __APP_LEDIT__
void D::chk_toponly::OnChanged() {}
#endif`;
  test('resolves an ismo-only part inside an anonymous layout', () => {
    const a = fixtures.createWorkspaceIndex({tool:'ismo'}).analyzeDocument({uri:'file:///gui.axl',version:1,text});
    assert.deepStrictEqual(a.diagnostics, []);
    assert.deepStrictEqual(names(a.guiClasses[0].parts), ['chk_toponly']);
    assert.strictEqual(a.guiClasses[0].parts[0].parts[0].methods[0].name, 'OnCreate');
  });
  test('switches active GUI parts when the tool changes', () => {
    const index = fixtures.createWorkspaceIndex();
    for (const tool of ['axel', 'ismo', 'axel']) {
      index.configure({tool});
      const a = index.analyzeDocument({uri:'file:///gui.axl',version:1,text});
      assert.deepStrictEqual(a.diagnostics, []);
      assert.deepStrictEqual(names(a.guiClasses[0].parts), [tool === 'ismo' ? 'chk_toponly' : 'other']);
    }
  });
  test('collects nested conditional parts and inline events', () => {
    const a = fixtures.createWorkspaceIndex({tool:'ismo'}).analyzeDocument({uri:'file:///nested.axl',version:1,
      text:`class D : GCDialog {
#ifdef __APP_LEDIT__
#if 0
GCCheckBox inactive;
#elif 1
GCCheckBox active {
#if 1
OnCreate() {}
#endif
};
#endif
#endif
};`});
    assert.deepStrictEqual(a.diagnostics, []);
    assert.deepStrictEqual(names(a.guiClasses[0].parts), ['active']);
    assert.strictEqual(a.guiClasses[0].parts[0].methods[0]?.name, 'OnCreate');
  });
});
