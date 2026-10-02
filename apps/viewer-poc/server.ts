// rhwp 뷰어 시험 구현의 서버. `node apps/viewer-poc/server.ts`로 띄우고 http://127.0.0.1:4173 을 연다.
// 루프백(127.0.0.1)에만 바인드한다. 문서 바이트는 메모리에만 두고 디스크에 쓰지 않는다.
import { createViewerApp, HOST, PORT } from "./src/app.ts";

const { server } = createViewerApp();
server.listen(PORT, HOST, () => {
  console.log(`viewer-poc: http://${HOST}:${PORT}`);
});

const stop = (): void => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
