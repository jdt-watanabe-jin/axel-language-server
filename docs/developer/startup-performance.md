# Measuring initial analysis

Run `npm run test:external -- --grep "External startup performance"` with these environment variables:

| Variable | Value |
| --- | --- |
| `AXEL_STARTUP_SAMPLE` | Absolute path of the document to open; absent skips this test |
| `AXEL_STARTUP_ROOT` | Absolute workspace directory |
| `AXEL_STARTUP_SETTINGS` | JSON object returned as the `axel` workspace configuration |
| `AXEL_STARTUP_ENCODING` | Open document encoding, default `shift_jis` |
| `AXEL_STARTUP_OUTPUT` | Optional measurement JSON path, preferably under the OS temporary directory |
| `AXEL_STARTUP_BASELINE` | Optional previous measurement JSON for comparison |
| `AXEL_STARTUP_PROFILE_DIR` | Optional existing directory for Node CPU profiles; use a separate run |

The test starts three server processes sequentially, using the current checkout's compiled `out/server.js`.
It measures from `didOpen` through the first diagnostic response, then repeats the diagnostic request.
The OS file cache is not cleared. This does not measure every simultaneous VS Code request or the completion of its progress UI.
Keep dependency files unchanged between runs, and do not run other performance tests concurrently.

The result includes runtime, source/configuration hashes, three samples, medians, and diagnostic digests.
Comparison rejects changed runtime, configuration, input or diagnostic results. The digest covers complete diagnostics,
including positions and duplicate entries; response order is ignored. Source and diagnostic text are not written to measurement JSON.
Use new output files for each run: output must not overwrite the source or baseline.

The open document is decoded with the specified encoding, matching the text supplied by an editor.
Disk dependencies retain the server's current UTF-8 decoding. This test does not change encoding support.
CPU profiling adds overhead: never compare a profiled measurement with a normal measurement.

`npm run test:performance -- --grep "Startup pipeline"` uses portable, generated fixtures for startup scripts,
forced includes, GUI classes, transitive includes and macros. Its analysis call count includes nested macro analysis;
it is not the count of distinct documents. No proprietary installation is required by CI.
