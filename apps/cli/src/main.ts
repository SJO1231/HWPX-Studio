#!/usr/bin/env node
import { run } from "./cli.ts";

try {
  process.exitCode = await run(process.argv.slice(2), {
    log: (line) => console.log(line),
    err: (line) => console.error(line),
  });
} catch (e) {
  console.error(`내부 오류: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 2;
}
