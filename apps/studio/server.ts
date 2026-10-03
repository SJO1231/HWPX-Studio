// 스튜디오(빠른 생성)의 서버. `node apps/studio/server.ts [--workspace <폴더>]`로 띄우고 http://127.0.0.1:4174 를 연다.
// 루프백(127.0.0.1)에만 바인드한다. 올린 문서·데이터는 메모리에만 두고, 만든 결과만 작업 공간의 out/ 폴더에 저장한다.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createStudioApp, HOST, PORT } from "./src/app.ts";

let workspace: string | undefined;
try {
  const { values } = parseArgs({ options: { workspace: { type: "string" } }, allowPositionals: false });
  if (values.workspace !== undefined) workspace = resolve(values.workspace);
} catch (e) {
  console.error(`${e instanceof Error ? e.message : String(e)}\n사용법: node apps/studio/server.ts [--workspace <폴더>]`);
  process.exit(2);
}

const app = createStudioApp(workspace === undefined ? {} : { workspace });
app.server.listen(PORT, HOST, () => {
  console.log(`studio: http://${HOST}:${PORT}`);
  console.log(`작업 공간: ${app.workspace}`);
});

const stop = (): void => {
  app.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
