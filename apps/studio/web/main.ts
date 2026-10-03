// 빠른 생성 화면. 문서·데이터·엔진은 서버(호스트)가 갖고, 이 화면은 올리고 고르고 결과를 보여 주기만 한다.
// 서버는 이 파일을 Node의 타입 제거로 바꿔서 준다(번들러 없음). 엔진과 Node 내장 모듈은 가져오지 않는다. 화면의 글은 textContent로만 넣는다.
import { createPageView, failureText, type PageView } from "../../../packages/viewer/src/dom/index.ts";
import { loadRhwp, openDocument, type ViewerDocument } from "../../../packages/viewer/src/rhwp/index.ts";
import type { CandidateKind, DataResponse, GenerateResponse, Match, PlacesView, ReportEntry, ResultView, StudioError, TemplateResponse, UnfillableShape } from "../src/api-types.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`화면 요소 #${id}이(가) 없습니다.`);
  return el as T;
};

const els = {
  status: $<HTMLElement>("status"),
  fileTemplate: $<HTMLInputElement>("file-template"),
  places: $<HTMLElement>("places"),
  fileData: $<HTMLInputElement>("file-data"),
  dataInfo: $<HTMLElement>("data-info"),
  matches: $<HTMLTableElement>("matches"),
  keysBox: $<HTMLDetailsElement>("keys-box"),
  keys: $<HTMLTableElement>("keys"),
  generate: $<HTMLButtonElement>("generate"),
  folderRow: $<HTMLElement>("folder-row"),
  folder: $<HTMLElement>("folder"),
  openFolder: $<HTMLButtonElement>("open-folder"),
  saveError: $<HTMLElement>("save-error"),
  results: $<HTMLTableElement>("results"),
  previewBox: $<HTMLElement>("preview-box"),
  previewTitle: $<HTMLElement>("preview-title"),
  preview: $<HTMLElement>("preview"),
};

const state: { session?: string; places?: PlacesView; hasData: boolean; records: number } = { hasData: false, records: 0 };

function setStatus(text: string, isError = false): void {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

const failed = (e: unknown): void => setStatus(e instanceof Error ? e.message : String(e), true);

/** 서버의 오류 응답은 쉬운 말(`plain`)을 먼저 보인다. 정적 파일 쪽 거절처럼 JSON이 아니거나 `plain`이 없으면 상태 코드로 설명한다. */
function errorText(status: number, text: string): string {
  try {
    const e = (JSON.parse(text) as StudioError | null)?.error;
    if (typeof e?.plain === "string") return `${e.plain} (${e.code})`;
  } catch {
    // JSON이 아니다
  }
  return failureText(status, text);
}

async function api<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(errorText(res.status, text));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(failureText(res.status, text));
  }
}

const postJson = <T>(path: string, body: unknown): Promise<T> => api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const postFile = <T>(path: string, file: File): Promise<T> => api<T>(path, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function fillTable(table: HTMLTableElement, head: string[], rows: (string | Node)[][]): void {
  const thead = el("thead");
  const tr = el("tr");
  for (const h of head) tr.append(el("th", h));
  thead.append(tr);
  const tbody = el("tbody");
  for (const row of rows) {
    const r = el("tr");
    for (const cell of row) {
      const td = el("td");
      td.append(cell);
      r.append(td);
    }
    tbody.append(r);
  }
  table.replaceChildren(thead, tbody);
}

// ── 1. 문서: 자리 목록 ───────────────────────────────────────────

const CANDIDATE: Record<CandidateKind, string> = { emptyCell: "라벨 옆 빈 칸", labelColon: "라벨: 뒤 빈 곳", blankMark: "빈칸 표시" };

/** 채울 수 없는 누름틀 모양의 쉬운 말: 자리 목록(건수와 함께)과 대조표(모양 이름만)에서 쓴다 */
const SHAPE_COUNTED: Record<UnfillableShape, string> = { crossParagraph: "여러 문단에 걸침", inline: "안에 줄바꿈·탭·그림", unpaired: "끝 표식 없음" };
const SHAPE_PLAIN: Record<UnfillableShape, string> = { crossParagraph: "여러 문단에 걸침", inline: "안에 줄바꿈·탭·그림이 있음", unpaired: "끝 표식 없음" };

const NO_NAME = "(이름 없음)";

type FieldPlace = PlacesView["fields"][number];

function fieldText(f: FieldPlace): string {
  const bad = f.unfillable.reduce((sum, u) => sum + u.count, 0);
  const shapes = f.unfillable.map((u) => `${SHAPE_COUNTED[u.shape]} ${u.count}`).join(", ");
  const unusable = f.usable ? "" : f.name === "" ? " — 이름이 없어 키로 쓸 수 없음" : " — 이름에 공백·점 등이 있어 키로 쓸 수 없음";
  return `${f.name === "" ? NO_NAME : f.name} (${f.count}곳)${unusable}${bad === 0 ? "" : ` — 그중 ${bad}곳은 채울 수 없는 모양(${shapes})`}`;
}

function renderPlaces(t: TemplateResponse): void {
  const { fields, placeholders, candidates, candidatesTruncated } = t.places;
  const box = els.places;
  box.replaceChildren();
  box.append(el("p", `${t.name} (${t.bytes.toLocaleString()}바이트)`, "muted"));
  const list = (title: string, items: string[], empty: string): void => {
    box.append(el("h3", `${title} ${items.length}개`));
    if (items.length === 0) box.append(el("p", empty, "muted"));
    else {
      const ul = el("ul");
      for (const text of items) ul.append(el("li", text));
      box.append(ul);
    }
  };
  list("누름틀", fields.map(fieldText), "문서에 누름틀이 없습니다.");
  list("{{키}}", placeholders.map((p) => `{{${p.key}}} (${p.count}곳)`), "문서에 {{키}}가 없습니다.");
  const cands = el("div", undefined, "cands");
  box.append(el("h3", `후보 자리 ${candidates.length}${candidatesTruncated ? "개 이상" : "개"} (표시만 하고 채우지 않습니다)`), cands);
  const ul = el("ul");
  for (const c of candidates) ul.append(el("li", `${CANDIDATE[c.kind]}: ${c.evidence}`));
  cands.append(ul);
}

// ── 2. 데이터: 대조표 ────────────────────────────────────────────

/** `records`는 판정한 건수(객체가 아닌 건은 뺀다). `places`는 채울 수 없는 모양의 이름을 찾는 데 쓴다. */
function stateText(m: Match, records: number, places: PlacesView | undefined): { text: string; className: string } {
  if (m.state === "ok") {
    // 줄바꿈·탭은 거절이 아니다: 엔진이 같은 문단 안의 줄바꿈·탭으로 넣는다(정보 표시)
    const info = m.multiline === 0 ? "" : ` — 값에 줄바꿈·탭이 있음(그대로 들어감${records > 1 ? `, ${m.multiline}건` : ""})`;
    return { text: `데이터 있음${info}`, className: "ok" };
  }
  if (m.state === "badKey") return { text: "이름이 데이터 키로 쓸 수 없는 꼴(공백·점 등)이라 채우지 않음", className: "bad" };
  if (m.state === "unfillable") {
    const field = places?.fields.find((f) => f.name === m.key);
    const shapes = (field?.unfillable ?? []).map((u) => SHAPE_PLAIN[u.shape]).join("/");
    return { text: `채울 수 없는 모양이라 채우지 않음${shapes === "" ? "" : `(${shapes})`} — 한컴에서 한 문단 안의 글만 담는 누름틀로 다시 만들어 주세요`, className: "bad" };
  }
  const base: Record<"missing" | "notScalar" | "rejected", string> = {
    missing: "데이터에 없음",
    notScalar: "객체·배열이라 못 넣음",
    rejected: `값에 넣을 수 없는 문자가 있음${m.reason === undefined ? "" : `(${m.reason})`}`,
  };
  const bad = m.counts[m.state];
  return { text: records > 1 ? `${base[m.state]} — ${records}건 중 ${bad}건` : base[m.state], className: m.state === "missing" ? "warn" : "bad" };
}

const FORM: Record<DataResponse["form"], string> = { object: "객체 하나", array: "객체의 배열", bundle: "묶음 형식(객체 하나)", bundleArray: "묶음 형식(배열)" };

function renderData(d: DataResponse): void {
  const invalid = d.invalidRecords === 0 ? "" : ` (그중 ${d.invalidRecords}건은 객체가 아니라 실패합니다)`;
  els.dataInfo.replaceChildren(el("p", `${FORM[d.form]}: ${d.records}건을 만듭니다.${invalid}`));
  els.matches.hidden = false;
  fillTable(
    els.matches,
    ["자리", "키", "데이터와 맞는지"],
    d.matches.map((m) => {
      const s = stateText(m, d.records - d.invalidRecords, state.places);
      return [m.kind === "field" ? "누름틀" : "{{키}}", m.kind === "field" && m.key === "" ? NO_NAME : m.key, el("span", s.text, s.className)];
    }),
  );
  if (d.matches.length === 0) els.dataInfo.append(el("p", "문서에서 찾은 자리가 없습니다. 후보 자리는 표시만 하고 채우지 않습니다.", "warn"));
  els.keysBox.hidden = false;
  fillTable(
    els.keys,
    ["키", "종류", "있는 건수", "자리에 쓸 수 있음"],
    d.keys.map((k) => [k.path, k.type, `${k.records}건`, k.usable ? "예" : "아니오(공백·점 등)"]),
  );
  if (d.keysTruncated) els.dataInfo.append(el("p", "키가 많아 앞의 1000개만 보입니다.", "muted"));
}

// ── 3·4. 생성과 결과 ─────────────────────────────────────────────

function entryList(entries: ReportEntry[], className: string): Node {
  if (entries.length === 0) return el("span", "-", "muted");
  const ul = el("ul");
  for (const e of entries) {
    const li = el("li", undefined, className);
    li.append(`${e.place === undefined ? "" : `[${e.place}] `}${e.plain} `, el("code", e.code));
    if (e.detail !== undefined) li.append(el("div", e.detail, "muted"));
    ul.append(li);
  }
  return ul;
}

let preview: { view: PageView; doc: ViewerDocument } | undefined;
let rhwpReady = false;

function closePreview(): void {
  preview?.view.destroy();
  preview?.doc.free();
  preview = undefined;
  els.preview.replaceChildren();
  els.previewBox.hidden = true;
}

/** 결과를 기존 뷰어(읽기 전용)로 미리 본다. 누르기 이벤트는 쓰지 않는다. */
async function showPreview(session: string, r: ResultView): Promise<void> {
  if (!rhwpReady) {
    await loadRhwp({ wasmUrl: "/vendor/rhwp/rhwp_bg.wasm" });
    rhwpReady = true;
  }
  const res = await fetch(`/api/quick/result/${session}/${r.index}`);
  if (!res.ok) throw new Error(errorText(res.status, await res.text()));
  const doc = openDocument(new Uint8Array(await res.arrayBuffer()));
  closePreview();
  els.previewBox.hidden = false;
  els.previewTitle.textContent = `미리보기: ${r.name}`;
  preview = { view: createPageView({ container: els.preview, doc, scale: 0.7, onPick: () => {}, onError: failed }), doc };
}

function renderResults(g: GenerateResponse): void {
  closePreview();
  const okCount = g.results.filter((r) => r.ok).length;
  setStatus(`${g.results.length}건 중 ${okCount}건 만들었고 ${g.results.length - okCount}건은 실패했습니다.`, okCount < g.results.length);
  els.results.hidden = false;
  fillTable(
    els.results,
    ["번호", "파일 이름", "결과", "채운 자리", "건너뜀", "오류", "알림", "파일"],
    g.results.map((r) => {
      const file = el("span");
      if (r.ok) {
        const link = el("a", "내려받기");
        link.href = `/api/quick/result/${g.session}/${r.index}`;
        const view = el("button", "미리보기");
        view.type = "button";
        view.addEventListener("click", () => void showPreview(g.session, r).catch(failed));
        file.append(link, " ", view);
      } else file.append(el("span", "-", "muted"));
      return [String(r.index + 1), r.name, el("span", r.ok ? "성공" : "실패", r.ok ? "ok" : "bad"), `${r.filled}곳`, entryList(r.skipped, "warn"), entryList(r.errors, "bad"), entryList(r.notes, "muted"), file];
    }),
  );
  els.folderRow.hidden = g.folder === null;
  els.folder.textContent = g.folder ?? "";
  els.saveError.textContent = g.saveError === undefined ? (g.folder === null ? "만든 결과가 없어 저장한 파일이 없습니다." : "") : `${g.saveError.plain} (${g.saveError.code})`;
}

function clearResults(): void {
  els.results.hidden = true;
  els.folderRow.hidden = true;
  els.saveError.textContent = "";
  closePreview();
}

function resetBelowTemplate(): void {
  state.hasData = false;
  state.records = 0;
  els.fileData.value = "";
  els.dataInfo.replaceChildren();
  els.matches.hidden = true;
  els.keysBox.hidden = true;
  els.generate.disabled = true;
  clearResults();
}

// ── 시작 ─────────────────────────────────────────────────────────

function main(): void {
  els.fileTemplate.addEventListener("change", () => {
    const file = els.fileTemplate.files?.[0];
    if (file === undefined) return;
    resetBelowTemplate();
    delete state.session;
    delete state.places;
    els.fileData.disabled = true;
    els.places.replaceChildren();
    setStatus("문서를 읽는 중…");
    postFile<TemplateResponse>(`/api/quick/template?name=${encodeURIComponent(file.name)}`, file)
      .then((t) => {
        state.session = t.session;
        state.places = t.places;
        renderPlaces(t);
        els.fileData.disabled = false;
        setStatus("문서를 읽었습니다. 데이터를 올려 주세요.");
      })
      .catch(failed);
  });

  els.fileData.addEventListener("change", () => {
    const file = els.fileData.files?.[0];
    if (file === undefined || state.session === undefined) return;
    els.generate.disabled = true;
    clearResults();
    setStatus("데이터를 읽는 중…");
    postFile<DataResponse>(`/api/quick/data?session=${state.session}`, file)
      .then((d) => {
        state.hasData = true;
        state.records = d.records;
        renderData(d);
        els.generate.disabled = false;
        setStatus("데이터를 읽었습니다. 누락 정책을 고르고 [생성]을 누르세요.");
      })
      .catch(failed);
  });

  els.generate.addEventListener("click", () => {
    const session = state.session;
    if (session === undefined || !state.hasData) return;
    const missing = document.querySelector<HTMLInputElement>('input[name="missing"]:checked')?.value ?? "error";
    els.generate.disabled = true;
    setStatus("만드는 중…");
    postJson<GenerateResponse>("/api/quick/generate", { session, missing })
      .then(renderResults)
      .catch(failed)
      .finally(() => {
        els.generate.disabled = !state.hasData;
      });
  });

  els.openFolder.addEventListener("click", () => {
    if (state.session === undefined) return;
    postJson<{ opened: boolean }>("/api/quick/open-folder", { session: state.session }).catch(failed);
  });

  setStatus("문서(.hwpx)를 올려 주세요.");
}

main();
