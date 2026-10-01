import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync } from "node:fs";
import { crc32 } from "node:zlib";
import * as engine from "../src/index.ts";
import {
  HwpxError,
  LIMITS,
  openPackage,
  readArchive,
  readEntry,
  rewriteArchive,
  type Archive,
} from "../src/index.ts";
import {
  FIXTURE_NAMES,
  MINIMAL_HEADER,
  buildHwpx,
  buildZip,
  bytesEqual,
  cdRecordOf,
  cdRecords,
  copyOf,
  eocdOffset,
  hpfXml,
  readFixture,
  readFixtureText,
  sectionXml,
  sha256Hex,
  utf8,
} from "./helpers.ts";

function expectedSha(name: string): string {
  for (const line of readFixtureText("SHA256SUMS").split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m !== null && m[2] === `${name}.hwpx`) return m[1] ?? "";
  }
  throw new Error(`SHA256SUMS에 ${name}이 없다`);
}

function throwsCode(fn: () => unknown, code: string): HwpxError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HwpxError, `HwpxError가 아닌 예외: ${String(e)}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`${code} 예외가 나야 하는데 정상 종료했다`);
}

// ── RT3 ─────────────────────────────────────────────────────────────────

for (const name of FIXTURE_NAMES) {
  test(`RT3 빈 변경은 바이트 동일: ${name}`, () => {
    const bytes = readFixture(name);
    const before = sha256Hex(bytes);
    const archive = readArchive(bytes);
    for (const changes of [{}, { replace: new Map<string, Uint8Array>(), add: [] }]) {
      const out = rewriteArchive(bytes, archive, changes);
      assert.equal(out.length, bytes.length);
      assert.ok(bytesEqual(out, bytes), "전체 바이트가 같아야 한다");
      assert.equal(sha256Hex(out), expectedSha(name), "SHA256SUMS의 해시와도 같아야 한다");
    }
    assert.equal(sha256Hex(bytes), before, "입력을 바꾸면 안 된다");
  });
}

test("RT3 데이터 설명자·디렉터리 항목·EOCD 주석이 있는 ZIP도 빈 변경은 바이트 동일", () => {
  const zip = buildZip([
    { name: "mimetype", data: utf8("application/hwp+zip") },
    { name: "a.txt", data: utf8("가나다".repeat(50)), method: 8, descriptor: true },
    { name: "dir/", data: new Uint8Array(0) },
    { name: "b.bin", data: new Uint8Array([1, 2, 3, 4]), descriptor: true },
  ]);
  // 파일 끝에 EOCD 주석(길이 선언 포함)을 붙여 본다.
  const comment = Buffer.from("주석입니다", "utf8");
  const withComment = Buffer.concat([Buffer.from(zip), comment]);
  withComment.writeUInt16LE(comment.length, eocdOffset(withComment) + 20);
  const archive = readArchive(withComment);
  assert.equal(archive.entries.length, 4);
  assert.equal(Buffer.from(archive.comment).toString("utf8"), "주석입니다");
  const out = rewriteArchive(withComment, archive, {});
  assert.ok(bytesEqual(out, withComment));
});

test("RT3 첫 로컬 레코드 앞에 바이트가 있는 ZIP(오프셋이 그만큼 밀린 경우)도 빈 변경은 바이트 동일", () => {
  const plain = copyOf(buildZip([
    { name: "mimetype", data: utf8("application/hwp+zip") },
    { name: "a.txt", data: utf8("abc".repeat(40)), method: 8 },
  ]));
  const stub = Buffer.from("STUB-BYTES-BEFORE-ARCHIVE");
  const shifted = Buffer.concat([stub, plain]);
  const eocd = eocdOffset(shifted);
  shifted.writeUInt32LE(shifted.readUInt32LE(eocd + 16) + stub.length, eocd + 16);
  for (const rec of cdRecords(shifted)) shifted.writeUInt32LE(shifted.readUInt32LE(rec.at + 42) + stub.length, rec.at + 42);
  const archive = readArchive(shifted);
  assert.equal(archive.entries[0]?.localStart, stub.length);
  assert.ok(bytesEqual(rewriteArchive(shifted, archive, {}), shifted));
  // 바꾸는 항목이 있어도 앞쪽 바이트는 그대로 남고 결과는 다시 읽힌다
  const out = rewriteArchive(shifted, archive, { replace: new Map([["a.txt", utf8("changed")]]) });
  assert.ok(bytesEqual(out.subarray(0, stub.length), stub));
  assert.equal(new TextDecoder().decode(readEntry(readArchive(out), out, "a.txt")), "changed");
});

// ── ZIP 읽기 구조 (3.1) ─────────────────────────────────────────────────

test("3.1 localEnd는 다음 레코드 시작이고 데이터 설명자를 범위에 포함한다", () => {
  const zip = buildZip([
    { name: "first.txt", data: utf8("x".repeat(100)), method: 8, descriptor: true },
    { name: "second.txt", data: utf8("second") },
  ]);
  const archive = readArchive(zip);
  const [first, second] = archive.entries;
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.localStart, 0);
  assert.equal(first.localEnd, second.localStart);
  assert.equal(second.localEnd, archive.cdStart);
  assert.equal(first.localEnd - (first.dataStart + first.compressedSize), 16, "설명자 16바이트가 범위에 들어 있어야 한다");
  assert.equal(readEntry(archive, zip, "first.txt").length, 100);
});

test("3.1 fixtures의 항목 목록·순서·무압축 여부", () => {
  const d1 = readArchive(readFixture("D1"));
  assert.deepEqual(
    d1.entries.map((e) => e.name),
    [
      "mimetype",
      "META-INF/",
      "META-INF/container.xml",
      "Contents/",
      "Contents/content.hpf",
      "Contents/header.xml",
      "Contents/section0.xml",
      "Preview/",
      "Preview/PrvText.txt",
    ],
  );
  assert.equal(d1.entries.filter((e) => e.isDirectory).length, 3);
  const field = readArchive(readFixture("hancom-field"));
  assert.equal(field.entries[0]?.name, "mimetype");
  assert.equal(field.entries[0]?.method, 0);
  assert.equal(field.entries.find((e) => e.name === "Contents/section0.xml")?.method, 8);
  assert.equal(readEntry(field, readFixture("hancom-field"), "mimetype").length, 19);
});

// ── RT4 ─────────────────────────────────────────────────────────────────

function sameContent(a: Uint8Array, aa: Archive, b: Uint8Array, ba: Archive): void {
  assert.deepEqual(
    aa.entries.map((e) => e.name),
    ba.entries.map((e) => e.name),
    "항목 이름과 순서가 같아야 한다",
  );
  for (const e of aa.entries) {
    assert.ok(bytesEqual(readEntry(aa, a, e.name), readEntry(ba, b, e.name)), `${e.name}의 풀린 내용`);
  }
}

for (const name of FIXTURE_NAMES) {
  test(`RT4 같은 내용으로 항목 하나를 replace해도 내용·나머지 로컬 레코드가 같다: ${name}`, () => {
    const bytes = readFixture(name);
    const archive = readArchive(bytes);
    for (const target of archive.entries) {
      if (target.name === "mimetype") continue;
      const content = readEntry(archive, bytes, target.name);
      const out = rewriteArchive(bytes, archive, { replace: new Map([[target.name, content]]) });
      const outArchive = readArchive(out);
      sameContent(bytes, archive, out, outArchive);
      for (const e of archive.entries) {
        const o = outArchive.entries.find((x) => x.name === e.name);
        assert.ok(o !== undefined);
        if (e.name === target.name) {
          assert.equal(o.method, e.method, `${e.name}의 압축 방식 유지`);
          assert.equal(o.size, e.size);
          assert.equal(o.crc32, e.crc32);
          assert.equal(o.flags & 0x0008, 0, "데이터 설명자 비트는 꺼져 있어야 한다");
        } else {
          assert.ok(
            bytesEqual(bytes.subarray(e.localStart, e.localEnd), out.subarray(o.localStart, o.localEnd)),
            `${e.name}의 로컬 레코드가 그대로여야 한다 (바꾼 항목: ${target.name})`,
          );
        }
      }
    }
  });
}

test("RT4 데이터 설명자가 있던 항목을 replace하면 bit 3을 끄고 헤더에 크기를 쓴다", () => {
  const zip = buildZip([
    { name: "mimetype", data: utf8("application/hwp+zip") },
    { name: "a.txt", data: utf8("abc".repeat(40)), method: 8, descriptor: true },
    { name: "z.txt", data: utf8("tail") },
  ]);
  const archive = readArchive(zip);
  const out = rewriteArchive(zip, archive, { replace: new Map([["a.txt", utf8("abc".repeat(40))]]) });
  const o = readArchive(out);
  const a = o.entries.find((e) => e.name === "a.txt");
  assert.ok(a !== undefined);
  assert.equal(a.flags & 0x0008, 0);
  const buf = Buffer.from(out);
  assert.equal(buf.readUInt16LE(a.localStart + 6) & 0x0008, 0, "로컬 헤더의 플래그");
  assert.equal(buf.readUInt32LE(a.localStart + 14), crc32(utf8("abc".repeat(40))), "로컬 헤더의 CRC");
  assert.equal(buf.readUInt32LE(a.localStart + 18), a.compressedSize);
  assert.equal(buf.readUInt32LE(a.localStart + 22), 120);
  assert.equal(a.localEnd, o.entries.find((e) => e.name === "z.txt")?.localStart, "설명자 없이 바로 다음 레코드");
  sameContent(zip, archive, out, o);
});

test("3.2 내용이 다른 replace는 그 항목만 바꾸고 이어지는 오프셋을 고친다", () => {
  const bytes = readFixture("D1");
  const archive = readArchive(bytes);
  const newText = "<changed/>".repeat(1000);
  const before = sha256Hex(bytes);
  const out = rewriteArchive(bytes, archive, { replace: new Map([["Contents/section0.xml", utf8(newText)]]) });
  assert.equal(sha256Hex(bytes), before, "입력 바이트를 건드리지 않는다");
  const o = readArchive(out);
  assert.equal(new TextDecoder().decode(readEntry(o, out, "Contents/section0.xml")), newText);
  for (const e of archive.entries) {
    if (e.name === "Contents/section0.xml") continue;
    assert.ok(bytesEqual(readEntry(archive, bytes, e.name), readEntry(o, out, e.name)), e.name);
  }
  // 뒤따르는 항목(Preview/…)의 중앙 디렉터리 오프셋이 새 위치를 가리킨다.
  assert.equal(readEntry(o, out, "Preview/PrvText.txt").length, archive.entries.find((e) => e.name === "Preview/PrvText.txt")?.size);
});

test("3.2 add는 기존 로컬 레코드 뒤·CD 앞에 붙고 UTF-8 플래그·고정 시각을 쓴다", () => {
  for (const name of ["D1", "hancom-field"]) {
    const bytes = readFixture(name);
    const archive = readArchive(bytes);
    const stored = utf8("저장만 한다");
    const packed = utf8("압축한다".repeat(30));
    const out = rewriteArchive(bytes, archive, {
      add: [
        { name: "BinData/한글.bin", data: stored, method: 0 },
        { name: "BinData/packed.bin", data: packed, method: 8 },
      ],
    });
    const o = readArchive(out);
    assert.equal(o.entries.length, archive.entries.length + 2);
    assert.deepEqual(
      o.entries.map((e) => e.name),
      [...archive.entries.map((e) => e.name), "BinData/한글.bin", "BinData/packed.bin"],
    );
    const a = o.entries[o.entries.length - 2];
    const b = o.entries[o.entries.length - 1];
    assert.ok(a !== undefined && b !== undefined);
    assert.ok(bytesEqual(readEntry(o, out, a.name), stored));
    assert.ok(bytesEqual(readEntry(o, out, b.name), packed));
    assert.equal(a.method, 0);
    assert.equal(b.method, 8);
    assert.equal(a.flags & 0x0800, 0x0800);
    const buf = Buffer.from(out);
    assert.equal(buf.readUInt16LE(a.localStart + 10), 0, "시각");
    assert.equal(buf.readUInt16LE(a.localStart + 12), (1 << 5) | 1, "날짜 1980-01-01");
    assert.equal(buf.readUInt16LE(a.cdRecord.start + 14), (1 << 5) | 1);
    // 기존 레코드는 바이트 그대로
    for (const e of archive.entries) {
      const x = o.entries.find((y) => y.name === e.name);
      assert.ok(x !== undefined);
      assert.equal(x.localStart, e.localStart);
      assert.ok(bytesEqual(bytes.subarray(e.localStart, e.localEnd), out.subarray(x.localStart, x.localEnd)));
    }
    assert.equal(openPackage(out).binaryEntries.length, 2);
  }
});

test("3.2 mimetype은 바꾸거나 추가할 수 없다 (PKG_MIMETYPE_LOCKED)", () => {
  const bytes = readFixture("D1");
  const archive = readArchive(bytes);
  throwsCode(() => rewriteArchive(bytes, archive, { replace: new Map([["mimetype", utf8("x")]]) }), "PKG_MIMETYPE_LOCKED");
  throwsCode(() => rewriteArchive(bytes, archive, { add: [{ name: "mimetype", data: utf8("x"), method: 0 }] }), "PKG_MIMETYPE_LOCKED");
});

test("3.2 없는 항목 replace는 PKG_MISSING, 이미 있는 이름이나 중복 add는 PKG_DUP_ENTRY", () => {
  const bytes = readFixture("D1");
  const archive = readArchive(bytes);
  throwsCode(() => rewriteArchive(bytes, archive, { replace: new Map([["nope.xml", utf8("x")]]) }), "PKG_MISSING");
  throwsCode(() => rewriteArchive(bytes, archive, { add: [{ name: "Contents/header.xml", data: utf8("x"), method: 0 }] }), "PKG_DUP_ENTRY");
  throwsCode(
    () =>
      rewriteArchive(bytes, archive, {
        add: [
          { name: "new.bin", data: utf8("x"), method: 0 },
          { name: "new.bin", data: utf8("y"), method: 0 },
        ],
      }),
    "PKG_DUP_ENTRY",
  );
});

// ── RT5: ZIP 계층의 반례 ────────────────────────────────────────────────

test("RT5 ZIP이 아니면 PKG_NOT_ZIP", () => {
  // fixture 안의 XML 항목(ZIP이 아닌 바이트)을 입력으로 쓴다.
  const bytes = readFixture("D1");
  const notZip = readEntry(readArchive(bytes), bytes, "Contents/header.xml");
  throwsCode(() => readArchive(notZip), "PKG_NOT_ZIP");
  throwsCode(() => readArchive(new Uint8Array(0)), "PKG_NOT_ZIP");
  throwsCode(() => openPackage(notZip), "PKG_NOT_ZIP");
});

test("RT5 OLE2 서명(D0 CF 11 E0)이면 PKG_IS_HWP5", () => {
  const buf = copyOf(readFixture("D1"));
  buf.set([0xd0, 0xcf, 0x11, 0xe0], 0);
  throwsCode(() => readArchive(buf), "PKG_IS_HWP5");
  throwsCode(() => openPackage(buf), "PKG_IS_HWP5");
});

test("RT5 잘린 파일은 PKG_TRUNCATED", () => {
  for (const name of ["D1", "hancom-field"]) {
    const bytes = readFixture(name);
    throwsCode(() => readArchive(bytes.subarray(0, Math.floor(bytes.length / 2))), "PKG_TRUNCATED");
    throwsCode(() => readArchive(bytes.subarray(0, bytes.length - 10)), "PKG_TRUNCATED");
    throwsCode(() => openPackage(bytes.subarray(0, 100)), "PKG_TRUNCATED");
  }
});

test("RT5 범위 밖 로컬 오프셋은 PKG_TRUNCATED", () => {
  const buf = copyOf(readFixture("D1"));
  const rec = cdRecordOf(buf, "Contents/header.xml");
  buf.writeUInt32LE(buf.length + 1000, rec + 42);
  throwsCode(() => readArchive(buf), "PKG_TRUNCATED");
});

test("RT5 CRC가 훼손되면 PKG_CRC", () => {
  // (1) 무압축 항목의 데이터 한 바이트를 뒤집는다.
  const stored = copyOf(readFixture("D1"));
  const archive = readArchive(stored);
  const entry = archive.entries.find((e) => e.name === "Contents/header.xml");
  assert.ok(entry !== undefined);
  stored[entry.dataStart + 100] = (stored[entry.dataStart + 100] ?? 0) ^ 0xff;
  const damaged = readArchive(stored); // 구조는 멀쩡하다
  throwsCode(() => readEntry(damaged, stored, "Contents/header.xml"), "PKG_CRC");
  assert.ok(readEntry(damaged, stored, "Contents/section0.xml").length > 0, "다른 항목은 읽힌다");

  // (2) 압축 항목의 중앙 디렉터리 CRC 값을 틀리게 한다.
  const packed = copyOf(readFixture("hancom-field"));
  const rec = cdRecordOf(packed, "Contents/section0.xml");
  packed.writeUInt32LE((packed.readUInt32LE(rec + 16) ^ 1) >>> 0, rec + 16);
  const a2 = readArchive(packed);
  throwsCode(() => readEntry(a2, packed, "Contents/section0.xml"), "PKG_CRC");
  // openPackage는 CRC가 틀린 항목을 읽는 순간 같은 코드로 실패한다
  const mimeRec = cdRecordOf(packed, "mimetype");
  packed.writeUInt32LE(0, mimeRec + 16);
  throwsCode(() => openPackage(packed), "PKG_CRC");
});

test("RT5 암호화 플래그가 있으면 PKG_ENCRYPTED", () => {
  const buf = copyOf(readFixture("D1"));
  const rec = cdRecordOf(buf, "Contents/section0.xml");
  buf.writeUInt16LE(buf.readUInt16LE(rec + 8) | 0x0001, rec + 8);
  const e = throwsCode(() => readArchive(buf), "PKG_ENCRYPTED");
  assert.equal(e.where, "Contents/section0.xml");
});

test("3.1 그 밖의 거부: ZIP64, 여러 디스크, 압축 방식, 이름 중복", () => {
  const zip64 = copyOf(readFixture("D1"));
  zip64.writeUInt16LE(0xffff, eocdOffset(zip64) + 10);
  throwsCode(() => readArchive(zip64), "PKG_ZIP64");

  const sizeZip64 = copyOf(readFixture("D1"));
  sizeZip64.writeUInt32LE(0xffffffff, cdRecordOf(sizeZip64, "Contents/header.xml") + 24);
  throwsCode(() => readArchive(sizeZip64), "PKG_ZIP64");

  const locator = copyOf(readFixture("D1"));
  const eocd = eocdOffset(locator);
  const withLocator = Buffer.concat([locator.subarray(0, eocd), Buffer.alloc(20), locator.subarray(eocd)]);
  withLocator.writeUInt32LE(0x07064b50, eocd);
  throwsCode(() => readArchive(withLocator), "PKG_ZIP64");

  const multi = copyOf(readFixture("D1"));
  multi.writeUInt16LE(1, eocdOffset(multi) + 4);
  throwsCode(() => readArchive(multi), "PKG_MULTI_DISK");

  const method = copyOf(readFixture("D1"));
  method.writeUInt16LE(99, cdRecordOf(method, "Contents/header.xml") + 10);
  throwsCode(() => readArchive(method), "PKG_METHOD");

  // 이름 길이가 같은 두 항목(Preview/PrvText.txt, Contents/header.xml; 둘 다 19바이트)의 이름을 같게 만든다.
  const dup = copyOf(readFixture("D1"));
  assert.equal(Buffer.byteLength("Preview/PrvText.txt"), Buffer.byteLength("Contents/header.xml"));
  dup.write("Contents/header.xml", cdRecordOf(dup, "Preview/PrvText.txt") + 46, "utf8");
  throwsCode(() => readArchive(dup), "PKG_DUP_ENTRY");
});

test("3.1 한도는 중앙 디렉터리의 선언값으로 먼저 판정한다 (PKG_LIMIT)", () => {
  const count = copyOf(readFixture("D1"));
  count.writeUInt16LE(LIMITS.entries + 1, eocdOffset(count) + 8);
  count.writeUInt16LE(LIMITS.entries + 1, eocdOffset(count) + 10);
  throwsCode(() => readArchive(count), "PKG_LIMIT");

  const big = copyOf(readFixture("D1"));
  big.writeUInt32LE(256 * 1024 * 1024 + 1, cdRecordOf(big, "Contents/header.xml") + 24);
  throwsCode(() => readArchive(big), "PKG_LIMIT");

  const total = copyOf(readFixture("D1"));
  for (const name of ["Contents/header.xml", "Contents/section0.xml", "Preview/PrvText.txt", "Contents/content.hpf"]) {
    total.writeUInt32LE(256 * 1024 * 1024, cdRecordOf(total, name) + 24);
    total.writeUInt32LE(256 * 1024 * 1024, cdRecordOf(total, name) + 20);
  }
  throwsCode(() => readArchive(total), "PKG_LIMIT");

  const ratio = copyOf(readFixture("hancom-field"));
  const rec = cdRecordOf(ratio, "Contents/section0.xml");
  ratio.writeUInt32LE(2 * 1024 * 1024, rec + 24); // 풀린 크기 2MiB 선언, 압축 크기는 1510바이트 → 1000:1 이상
  throwsCode(() => readArchive(ratio), "PKG_LIMIT");
});

test("3.1 선언보다 많이 풀리는 압축 항목은 PKG_INFLATE", () => {
  const buf = copyOf(readFixture("hancom-field"));
  const rec = cdRecordOf(buf, "Contents/section0.xml");
  buf.writeUInt32LE(100, rec + 24); // 실제는 3920바이트
  const a = readArchive(buf);
  throwsCode(() => readEntry(a, buf, "Contents/section0.xml"), "PKG_INFLATE");
});

// ── 패키지 열기 (3.3) ───────────────────────────────────────────────────

for (const name of FIXTURE_NAMES) {
  test(`3.3 패키지 열기: ${name}`, () => {
    const pkg = openPackage(readFixture(name));
    assert.equal(pkg.headerEntry, "Contents/header.xml");
    assert.deepEqual(pkg.sectionEntries, ["Contents/section0.xml"]);
    assert.deepEqual(pkg.issues, [], "fixtures는 mimetype 규칙을 지킨다");
    assert.deepEqual(pkg.binaryEntries, []);
    const ids = pkg.manifestItems.map((m) => m.id);
    assert.ok(ids.includes("header") && ids.includes("section0"));
    const section = pkg.manifestItems.find((m) => m.id === "section0");
    assert.deepEqual(section, { id: "section0", href: "Contents/section0.xml", mediaType: "application/xml" });
  });
}

test("3.3 mimetype 위반은 열기는 하되 경고로 남긴다", () => {
  const base = buildHwpx([""]);
  const baseArchive = readArchive(base);
  const get = (n: string) => readEntry(baseArchive, base, n);
  const rest = ["META-INF/container.xml", "Contents/content.hpf", "Contents/header.xml", "Contents/section0.xml"].map((name) => ({
    name,
    data: get(name),
    method: 8 as const,
  }));
  const mime = (content: string, method: 0 | 8) => ({ name: "mimetype", data: utf8(content), method });
  const codes = (bytes: Uint8Array) => openPackage(bytes).issues.map((i) => `${i.severity}:${i.code}`);

  assert.deepEqual(codes(buildZip([mime("application/hwp+zip", 0), ...rest])), []);
  assert.deepEqual(codes(buildZip([...rest.slice(0, 1), mime("application/hwp+zip", 0), ...rest.slice(1)])), ["warning:PKG_MIMETYPE_POSITION"]);
  assert.deepEqual(codes(buildZip([mime("application/hwp+zip", 8), ...rest])), ["warning:PKG_MIMETYPE_COMPRESSED"]);
  assert.deepEqual(codes(buildZip([mime("application/zip", 0), ...rest])), ["warning:PKG_MIMETYPE_CONTENT"]);
  assert.deepEqual(codes(buildZip(rest)), ["warning:PKG_MIMETYPE_MISSING"]);
});

function packageWith(sections: number[], spine: string[], extra: { name: string; data: Uint8Array }[] = []): Uint8Array {
  return buildZip([
    { name: "mimetype", data: utf8("application/hwp+zip") },
    {
      name: "META-INF/container.xml",
      data: readEntry(readArchive(buildHwpx([""])), buildHwpx([""]), "META-INF/container.xml"),
    },
    { name: "Contents/content.hpf", data: utf8(hpfXml(sections, spine)) },
    { name: "Contents/header.xml", data: utf8(MINIMAL_HEADER) },
    ...sections.map((n) => ({ name: `Contents/section${n}.xml`, data: utf8(sectionXml("")) })),
    ...extra,
  ]);
}

test("3.3 구역은 spine 순서를 따르고, spine에 없는 구역은 숫자 순으로 뒤에 붙이며 경고한다", () => {
  // manifest에는 section0·1·2·10이 모두 있고 spine에는 header, section1, section0만 있다.
  const pkg = openPackage(packageWith([0, 1, 2, 10], ["header", "section1", "section0"]));
  assert.deepEqual(pkg.sectionEntries, [
    "Contents/section1.xml",
    "Contents/section0.xml",
    "Contents/section2.xml",
    "Contents/section10.xml", // 문자열 순서였다면 section10이 section2보다 앞선다
  ]);
  assert.deepEqual(
    pkg.issues.map((i) => `${i.severity}:${i.code}:${i.where}`),
    ["warning:PKG_SECTION_NOT_IN_SPINE:Contents/section2.xml", "warning:PKG_SECTION_NOT_IN_SPINE:Contents/section10.xml"],
  );
});

test("3.3 BinData 아래 파일 항목을 binaryEntries에 모은다", () => {
  const pkg = openPackage(
    packageWith([0], ["header", "section0"], [
      { name: "BinData/", data: new Uint8Array(0) },
      { name: "BinData/image1.png", data: new Uint8Array([1, 2, 3]) },
      { name: "Preview/PrvImage.png", data: new Uint8Array([4]) },
    ]),
  );
  assert.deepEqual(pkg.binaryEntries, ["BinData/image1.png"]);
});

test("3.3 필수 항목이 없으면 PKG_MISSING", () => {
  const good = buildHwpx([""]);
  const ga = readArchive(good);
  const get = (n: string) => readEntry(ga, good, n);
  const mime = { name: "mimetype", data: utf8("application/hwp+zip") };
  // container.xml 없음
  throwsCode(() => openPackage(buildZip([mime, { name: "Contents/header.xml", data: get("Contents/header.xml") }])), "PKG_MISSING");
  // content.hpf 없음
  throwsCode(
    () => openPackage(buildZip([mime, { name: "META-INF/container.xml", data: get("META-INF/container.xml") }])),
    "PKG_MISSING",
  );
  // header 없음
  throwsCode(
    () =>
      openPackage(
        buildZip([
          mime,
          { name: "META-INF/container.xml", data: get("META-INF/container.xml") },
          { name: "Contents/content.hpf", data: get("Contents/content.hpf") },
          { name: "Contents/section0.xml", data: get("Contents/section0.xml") },
        ]),
      ),
    "PKG_MISSING",
  );
  // 구역 없음
  throwsCode(
    () =>
      openPackage(
        buildZip([
          mime,
          { name: "META-INF/container.xml", data: get("META-INF/container.xml") },
          { name: "Contents/content.hpf", data: utf8(hpfXml([], ["header"])) },
          { name: "Contents/header.xml", data: get("Contents/header.xml") },
        ]),
      ),
    "PKG_MISSING",
  );
});

test("3.3 XML 항목이 UTF-8이 아니면 XML_ENCODING, BOM이 있어도 열린다", () => {
  const good = buildHwpx([""]);
  const ga = readArchive(good);
  const get = (n: string) => readEntry(ga, good, n);
  const bad = Buffer.concat([Buffer.from(get("META-INF/container.xml")), Buffer.from([0xff, 0xfe, 0x80])]);
  const withEntry = (container: Uint8Array) =>
    buildZip([
      { name: "mimetype", data: utf8("application/hwp+zip") },
      { name: "META-INF/container.xml", data: container },
      { name: "Contents/content.hpf", data: get("Contents/content.hpf") },
      { name: "Contents/header.xml", data: get("Contents/header.xml") },
      { name: "Contents/section0.xml", data: get("Contents/section0.xml") },
    ]);
  throwsCode(() => openPackage(withEntry(bad)), "XML_ENCODING");
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(get("META-INF/container.xml"))]);
  assert.equal(openPackage(withEntry(bom)).headerEntry, "Contents/header.xml");
});

test("3.3 열기는 입력 바이트와 archive를 그대로 노출한다", () => {
  const bytes = readFixture("D2");
  const pkg = openPackage(bytes);
  assert.equal(pkg.bytes, bytes);
  assert.equal(pkg.archive.entries.length, readArchive(bytes).entries.length);
  assert.equal(cdRecords(copyOf(bytes)).length, pkg.archive.entries.length);
});

// ── 18개 정상 fixtures ───────────────────────────────────────────────────

/** test/fixtures 바로 아래, hancom/, extra/ 의 모든 .hwpx (확장자 뺀 상대 경로) */
function allFixtureNames(): string[] {
  const root = new URL("./fixtures/", import.meta.url);
  const out: string[] = [];
  for (const dir of ["", "hancom/", "extra/"]) {
    for (const f of readdirSync(new URL(dir, root)).sort()) {
      if (f.endsWith(".hwpx")) out.push(`${dir}${f.slice(0, -5)}`);
    }
  }
  return out;
}

test("정상 fixtures는 18개이고 모두 열리며 모든 항목이 CRC까지 읽힌다", () => {
  const names = allFixtureNames();
  assert.equal(names.length, 18);
  for (const name of names) {
    const bytes = readFixture(name);
    const pkg = openPackage(bytes);
    assert.ok(pkg.sectionEntries.length >= 1, name);
    for (const e of pkg.archive.entries) {
      if (!e.isDirectory) readEntry(pkg.archive, bytes, e.name);
    }
  }
});

// ── 교체 항목의 범용 플래그 (3.2 보강: 바꾸는 플래그는 bit 3 하나뿐) ──────────────────

/** 이름 항목 하나의 로컬 헤더와 CD 레코드 플래그를 같은 값으로 바꾼 사본 */
function withFlags(zip: Uint8Array, name: string, flags: number): Buffer {
  const buf = copyOf(zip);
  const e = readArchive(buf).entries.find((x) => x.name === name);
  assert.ok(e !== undefined, name);
  buf.writeUInt16LE(flags, e.localStart + 6);
  buf.writeUInt16LE(flags, e.cdRecord.start + 8);
  return buf;
}

test("3.2 교체한 항목의 플래그는 bit 3만 꺼진다 (UTF-8 이름 표시 등 나머지 15비트는 원본 그대로)", () => {
  const NAME = "Contents/한글 이름.xml";
  const body = utf8("<a>가나다</a>".repeat(20));
  // [원본 플래그, 기대 플래그]. 기대값은 원본 & ~0x0008을 손으로 적은 것이다.
  const cases: [number, number][] = [
    [0x0800, 0x0800],
    [0x0808, 0x0800],
    [0x080a, 0x0802],
    [0x1800, 0x1800],
    [0x9808, 0x9800],
  ];
  for (const [orig, expected] of cases) {
    for (const method of [0, 8] as const) {
      const base = buildZip([
        { name: "mimetype", data: utf8("application/hwp+zip") },
        { name: NAME, data: body, method, descriptor: (orig & 0x0008) !== 0 },
        { name: "tail.txt", data: utf8("tail") },
      ]);
      const zip = withFlags(base, NAME, orig);
      const archive = readArchive(zip);
      assert.equal(archive.entries.find((e) => e.name === NAME)?.flags, orig, "준비: 원본 플래그");
      for (const [label, content] of [
        ["같은 내용", body],
        ["다른 내용", utf8("<b>다른 내용</b>".repeat(7))],
      ] as const) {
        const ctx = `플래그 0x${orig.toString(16)}, 방식 ${method}, ${label}`;
        const out = rewriteArchive(zip, archive, { replace: new Map([[NAME, content]]) });
        const o = readArchive(out);
        const e = o.entries.find((x) => x.name === NAME);
        assert.ok(e !== undefined, ctx);
        const buf = Buffer.from(out);
        assert.equal(buf.readUInt16LE(e.localStart + 6), expected, `${ctx}: 로컬 헤더 플래그`);
        assert.equal(buf.readUInt16LE(e.cdRecord.start + 8), expected, `${ctx}: CD 레코드 플래그`);
        assert.equal(e.flags, expected, ctx);
        assert.ok(bytesEqual(readEntry(o, out, NAME), content), `${ctx}: 내용`);
        // 바꾸지 않은 항목의 플래그는 그대로
        const tail = o.entries.find((x) => x.name === "tail.txt");
        assert.equal(tail?.flags, 0, ctx);
      }
    }
  }
});

test("3.2 플래그 비트별로: 교체 항목에서 bit 3 외의 비트는 하나도 바뀌지 않는다 (암호화 비트 제외)", () => {
  for (let bit = 0; bit < 16; bit++) {
    if (bit === 0 || bit === 6 || bit === 13) continue; // 읽기 단계에서 거부되는 비트
    const orig = 1 << bit;
    const base = buildZip([
      { name: "mimetype", data: utf8("application/hwp+zip") },
      { name: "한글.txt", data: utf8("abc"), method: 0, descriptor: bit === 3 },
    ]);
    const zip = withFlags(base, "한글.txt", orig);
    const out = rewriteArchive(zip, readArchive(zip), { replace: new Map([["한글.txt", utf8("changed")]]) });
    const e = readArchive(out).entries.find((x) => x.name === "한글.txt");
    assert.ok(e !== undefined);
    const buf = Buffer.from(out);
    const expected = orig & ~0x0008;
    assert.equal(buf.readUInt16LE(e.localStart + 6), expected, `bit ${bit}: 로컬 헤더`);
    assert.equal(buf.readUInt16LE(e.cdRecord.start + 8), expected, `bit ${bit}: CD 레코드`);
  }
});

// ── 암호화 플래그 (3.1 보강: CD 또는 로컬 헤더의 bit 0, 6, 13) ───────────────────────

test("3.1 암호화 비트(bit 0, 6, 13)는 CD 레코드나 로컬 헤더 한쪽에만 있어도 PKG_ENCRYPTED, 다른 비트는 거부하지 않는다", () => {
  const base = buildZip([
    { name: "mimetype", data: utf8("application/hwp+zip") },
    { name: "a.txt", data: utf8("abc".repeat(30)), method: 8 },
    { name: "b.txt", data: utf8("tail") },
  ]);
  const found = readArchive(base).entries.find((e) => e.name === "a.txt");
  assert.ok(found !== undefined);
  const encrypting = new Set([0, 6, 13]);
  for (let bit = 0; bit < 16; bit++) {
    for (const side of ["cd", "local"] as const) {
      const buf = copyOf(base);
      if (side === "cd") buf.writeUInt16LE(1 << bit, found.cdRecord.start + 8);
      else buf.writeUInt16LE(1 << bit, found.localStart + 6);
      const ctx = `bit ${bit}, ${side}`;
      if (encrypting.has(bit)) {
        const e = throwsCode(() => readArchive(buf), "PKG_ENCRYPTED");
        assert.equal(e.where, "a.txt", ctx);
      } else {
        assert.equal(readArchive(buf).entries.length, 3, ctx);
      }
    }
  }
});

test("3.1 로컬 헤더에만 bit 0이 있어도 openPackage는 PKG_ENCRYPTED", () => {
  const buf = copyOf(readFixture("D1"));
  const e = readArchive(buf).entries.find((x) => x.name === "Contents/section0.xml");
  assert.ok(e !== undefined);
  buf.writeUInt16LE(buf.readUInt16LE(e.localStart + 6) | 0x0001, e.localStart + 6);
  assert.equal(buf.readUInt16LE(e.cdRecord.start + 8) & 0x2041, 0, "준비: CD 레코드에는 표시가 없다");
  throwsCode(() => openPackage(buf), "PKG_ENCRYPTED");
});

test("3.1 CD 레코드의 bit 13(CD 암호화)은 PKG_ENCRYPTED", () => {
  const buf = copyOf(readFixture("hancom-field"));
  const rec = cdRecordOf(buf, "Contents/header.xml");
  buf.writeUInt16LE(buf.readUInt16LE(rec + 8) | 0x2000, rec + 8);
  throwsCode(() => openPackage(buf), "PKG_ENCRYPTED");
});

// ── 역슬래시 이름 (3.3 보강) ─────────────────────────────────────────────

/** 이름을 바꾼 사본(내용은 그대로). 기본은 `/`를 `\`로 바꾼다. 디렉터리 항목은 뺀다. */
function renamed(name: string, rename: (entryName: string) => string = (n) => n.replaceAll("/", "\\")): Uint8Array {
  const bytes = readFixture(name);
  const archive = readArchive(bytes);
  return buildZip(
    archive.entries
      .filter((e) => !e.isDirectory)
      .map((e) => ({ name: rename(e.name), data: readEntry(archive, bytes, e.name), method: e.method })),
  );
}

test("3.3 항목 이름의 구분자가 모두 역슬래시이면 PKG_BACKSLASH_NAMES (PKG_MISSING이 아니다)", () => {
  for (const name of ["D1", "hancom-field"]) {
    const zip = renamed(name);
    assert.ok(readArchive(zip).entries.some((e) => e.name === "Contents\\header.xml"), "준비: 이름이 역슬래시다");
    throwsCode(() => openPackage(zip), "PKG_BACKSLASH_NAMES");
  }
  // 대조: 이름을 건드리지 않은 같은 내용은 열린다
  assert.equal(openPackage(renamed("D1", (n) => n)).headerEntry, "Contents/header.xml");
});

test("3.3 필수 항목 하나만 역슬래시 이름이어도, manifest 쪽 경로까지 역슬래시여도 PKG_BACKSLASH_NAMES", () => {
  // header만 역슬래시
  throwsCode(
    () => openPackage(renamed("D1", (n) => (n === "Contents/header.xml" ? "Contents\\header.xml" : n))),
    "PKG_BACKSLASH_NAMES",
  );
  // 구역만 역슬래시
  throwsCode(
    () => openPackage(renamed("D1", (n) => (n === "Contents/section0.xml" ? "Contents\\section0.xml" : n))),
    "PKG_BACKSLASH_NAMES",
  );
  // 이름과 content.hpf의 href가 함께 역슬래시: 구역 파일을 못 찾는 경로
  const bytes = readFixture("D1");
  const archive = readArchive(bytes);
  const zip = buildZip(
    archive.entries
      .filter((e) => !e.isDirectory)
      .map((e) => {
        let data = readEntry(archive, bytes, e.name);
        if (e.name === "Contents/content.hpf") data = utf8(new TextDecoder().decode(data).replaceAll('href="Contents/', 'href="Contents\\'));
        const name = e.name.startsWith("Contents/") && e.name !== "Contents/content.hpf" ? e.name.replace("/", "\\") : e.name;
        return { name, data, method: e.method };
      }),
  );
  assert.ok(new TextDecoder().decode(readEntry(readArchive(zip), zip, "Contents/content.hpf")).includes('href="Contents\\section0.xml"'));
  throwsCode(() => openPackage(zip), "PKG_BACKSLASH_NAMES");
});

test("3.3 역슬래시 이름이 없으면 PKG_MISSING 그대로, 필수 항목이 다 있으면 역슬래시 이름은 열기를 막지 않는다", () => {
  const bytes = readFixture("D1");
  const archive = readArchive(bytes);
  const without = (skip: string, extra: { name: string; data: Uint8Array }[] = []) =>
    buildZip([
      ...archive.entries
        .filter((e) => !e.isDirectory && e.name !== skip)
        .map((e) => ({ name: e.name, data: readEntry(archive, bytes, e.name), method: e.method })),
      ...extra,
    ]);
  // 필수 항목이 없고 역슬래시 이름도 없다
  throwsCode(() => openPackage(without("Contents/header.xml")), "PKG_MISSING");
  throwsCode(() => openPackage(without("META-INF/container.xml")), "PKG_MISSING");
  throwsCode(() => openPackage(without("Contents/section0.xml")), "PKG_MISSING");
  // 필수 항목을 못 찾았고 다른 항목 이름에 역슬래시가 있으면 원인을 구별해 알린다
  throwsCode(() => openPackage(without("Contents/header.xml", [{ name: "BinData\\a.png", data: new Uint8Array([1]) }])), "PKG_BACKSLASH_NAMES");
  // 필수 항목이 모두 있으면 역슬래시 이름이 있어도 열린다
  const pkg = openPackage(without("", [{ name: "BinData\\a.png", data: new Uint8Array([1]) }]));
  assert.equal(pkg.headerEntry, "Contents/header.xml");
});

// ── rootfile 경로 노출 ───────────────────────────────────────────────────

/** container.xml의 rootfile 목록과 manifest·구역·header 항목을 가진 패키지. 패키지 문서 항목 이름은 `hpfName`이다. */
function packageWithRootfiles(rootfiles: string, hpfName: string): Uint8Array {
  const container =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>` +
    `<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles>${rootfiles}</ocf:rootfiles></ocf:container>`;
  return buildZip([
    { name: "mimetype", data: utf8("application/hwp+zip") },
    { name: "META-INF/container.xml", data: utf8(container) },
    { name: hpfName, data: utf8(hpfXml([0])) },
    { name: "Contents/header.xml", data: utf8(MINIMAL_HEADER) },
    { name: "Contents/section0.xml", data: utf8(sectionXml("")) },
    { name: "Preview/PrvText.txt", data: utf8("preview") },
  ]);
}

test("3.3 rootfile: 패키지 문서 항목의 경로를 노출한다 (fixtures 18개는 container.xml의 hwpml-package+xml 항목과 같다)", () => {
  for (const name of allFixtureNames()) {
    const bytes = readFixture(name);
    const pkg = openPackage(bytes);
    // 독립 기준: container.xml 원문에서 정규식으로 찾는다
    const container = new TextDecoder().decode(readEntry(pkg.archive, bytes, "META-INF/container.xml"));
    const expected = /<[\w:]*rootfile\b[^>]*?\sfull-path="([^"]*)"[^>]*?\smedia-type="application\/hwpml-package\+xml"/.exec(container)?.[1];
    assert.equal(expected, "Contents/content.hpf", `${name}: 기준값`);
    assert.equal(pkg.rootfile, expected, name);
  }
});

test("3.3 rootfile: 한컴 저장본처럼 미리보기가 앞에 있어도 media-type이 패키지 문서인 항목을 고른다. 이름이 content.hpf가 아니어도 된다", () => {
  const preview = `<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>`;
  const main = `<ocf:rootfile full-path="Package/main.hpf" media-type="application/hwpml-package+xml"/>`;
  const pkg = openPackage(packageWithRootfiles(preview + main, "Package/main.hpf"));
  assert.equal(pkg.rootfile, "Package/main.hpf");
  assert.equal(pkg.headerEntry, "Contents/header.xml");
  assert.deepEqual(pkg.sectionEntries, ["Contents/section0.xml"]);
});

test("3.3 rootfile: media-type이 없으면 .hpf로 끝나는 첫 항목이다", () => {
  const preview = `<ocf:rootfile full-path="Preview/PrvText.txt"/>`;
  const main = `<ocf:rootfile full-path="Package/alt.hpf"/>`;
  assert.equal(openPackage(packageWithRootfiles(preview + main, "Package/alt.hpf")).rootfile, "Package/alt.hpf");
});

// ── 공개 목록 ───────────────────────────────────────────────────────────

test("공개 목록: index가 검사기(validateDocument·compareToBaseline)를 내보내고 기존 공개 이름은 그대로다", () => {
  assert.equal(typeof engine.validateDocument, "function");
  assert.equal(typeof engine.compareToBaseline, "function");
  // export *가 이름 충돌로 기존 이름을 가리지 않았다
  for (const name of ["openPackage", "parseDocument", "planImport", "applyPlan", "extractFragment", "listFields", "tokenize", "HwpxError"]) {
    assert.equal(typeof (engine as Record<string, unknown>)[name], "function", name);
  }
  // 내보낸 함수가 실제로 동작한다: 정상 fixture의 검사 결과를 자기 자신과 대조하면 새 오류가 없다
  const report = engine.validateDocument(readFixture("D1"));
  assert.ok(Array.isArray(report.errors) && Array.isArray(report.warnings));
  assert.deepEqual(engine.compareToBaseline(report, report).newErrors, []);
});
