// 시험 구현의 웹 화면. rhwp(WASM)는 이 브라우저에서 돌고, 문서 바이트·위치 변환·앵커 초안·채움은 서버(호스트)가 한다.
// 서버는 이 파일을 Node의 타입 제거로 바꿔서 준다(번들러 없음). 엔진은 가져오지 않는다.
import { closeReplaced, createLatest, createPageView, defaultDraftIndex, failureText, type PageView, type PickEvent, type ViewMark } from "../../../packages/viewer/src/dom/index.ts";
import { loadRhwp, openDocument, type HitRegion, type ViewerDocument } from "../../../packages/viewer/src/rhwp/index.ts";
import type {
  AnchorDraftJson,
  DraftView,
  FillResponse,
  FixtureList,
  LocatePoint,
  LocateRequest,
  LocateResponse,
  MarksResponse,
  OpenResponse,
  ServerMark,
} from "../src/api-types.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`화면 요소 #${id}이(가) 없습니다.`);
  return el as T;
};

const els = {
  fixture: $<HTMLSelectElement>("fixture"),
  openFixture: $<HTMLButtonElement>("open-fixture"),
  file: $<HTMLInputElement>("file"),
  scale: $<HTMLInputElement>("scale"),
  scaleOut: $<HTMLOutputElement>("scale-out"),
  showMarks: $<HTMLInputElement>("show-marks"),
  reset: $<HTMLButtonElement>("reset"),
  download: $<HTMLAnchorElement>("download"),
  status: $<HTMLElement>("status"),
  pages: $<HTMLElement>("pages"),
  region: $<HTMLElement>("w-region"),
  address: $<HTMLElement>("w-address"),
  precision: $<HTMLElement>("w-precision"),
  note: $<HTMLElement>("w-note"),
  drafts: $<HTMLOListElement>("drafts"),
  value: $<HTMLInputElement>("value"),
  fill: $<HTMLButtonElement>("fill"),
  fillOut: $<HTMLElement>("fill-out"),
  marks: $<HTMLOListElement>("marks"),
};

type State = {
  session?: OpenResponse;
  doc?: ViewerDocument;
  view?: PageView;
  marks: ServerMark[];
  /** 방금 누른 자리를 표시하는 강조 */
  pick?: ViewMark;
  /** 고른 앵커 초안(채우기 대상) */
  chosen?: DraftView;
};

const state: State = { marks: [] };
/** locate 응답의 순서 번호표: 마지막으로 누른 점의 응답만 반영하고, 문서를 바꾸거나 채울 때는 그때까지 나간 요청의 응답을 버린다 */
const picks = createLatest();

const REGION: Record<HitRegion, string> = {
  body: "본문",
  cell: "표 셀·글상자",
  textbox: "글상자",
  header: "머리말",
  footer: "꼬리말",
  footnote: "각주",
  masterpage: "바탕쪽",
  object: "개체(그림 등)",
};

const PRECISION: Record<LocateResponse["precision"], string> = {
  char: "글자(char)",
  paragraph: "문단(paragraph)",
  none: "옮기지 못함",
};

function setStatus(text: string, isError = false): void {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  // 본문이 JSON이라고 믿지 않는다(서버 앞단의 거절이 글로 올 수 있다): 글로 읽고, 실패면 상태 코드로 설명한다
  const text = await res.text();
  if (!res.ok) throw new Error(failureText(res.status, text));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(failureText(res.status, text));
  }
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ── 문서 열기·그리기 ──────────────────────────────────────────────

function viewMarks(): ViewMark[] {
  const out: ViewMark[] = [];
  if (els.showMarks.checked) {
    for (const m of state.marks) {
      if (m.mark === undefined) continue;
      out.push({ id: m.id, kind: m.kind, position: m.mark.position, endOffset: m.mark.endOffset, ...(m.mark.guide === undefined ? {} : { guide: m.mark.guide }), ...(m.mark.text === undefined ? {} : { text: m.mark.text }) });
    }
  }
  const chosen = state.chosen?.mark;
  if (chosen !== undefined) {
    out.push({ id: "chosen", kind: "chosen", position: chosen.position, endOffset: chosen.endOffset, ...(chosen.guide === undefined ? {} : { guide: chosen.guide }), ...(chosen.text === undefined ? {} : { text: chosen.text }) });
  }
  if (state.pick !== undefined) out.push(state.pick);
  return out;
}

function refreshMarks(): void {
  state.view?.setMarks(viewMarks());
}

const describe = (a: AnchorDraftJson): { kind: string; text: string; sub: string } => {
  switch (a.kind) {
    case "field":
      return a.mergeKey === undefined
        ? { kind: "누름틀", text: `"${a.name}"`, sub: a.occurrence === undefined ? "" : `같은 이름 ${a.occurrence + 1}번째` }
        : { kind: "메일 머지", text: `"${a.mergeKey}"`, sub: a.occurrence === undefined ? "" : `같은 키 ${a.occurrence + 1}번째` };
    case "word":
      return { kind: "낱말", text: `"${a.print.text}"`, sub: `앞 "${a.print.before.slice(-12)}" 뒤 "${a.print.after.slice(0, 12)}"` };
    case "line":
      return { kind: "문단", text: `"${a.print.text.slice(0, 40)}"`, sub: `주소 [${a.at.path.join(", ")}]` };
    case "cell":
      return { kind: "표 셀", text: `표 ${a.table.ordinal + 1}의 ${a.row + 1}행 ${a.col + 1}열`, sub: "" };
    case "range":
      return { kind: "문단 범위", text: `"${a.print.first.text}" ~ "${a.print.last.text}"`, sub: `문단 ${a.from}~${a.to}(${a.print.count}개)` };
    case "headingRange":
      return { kind: "제목 범위", text: `"${a.heading.text}"`, sub: `문단 ${a.index}부터 ${a.print.count}개` };
  }
};

function renderChoices(list: HTMLOListElement, items: { anchor: AnchorDraftJson; mark?: DraftView["mark"]; extra?: string; blocked?: string }[], onChoose: (i: number) => void): void {
  list.replaceChildren();
  items.forEach((item, i) => {
    const d = describe(item.anchor);
    const li = document.createElement("li");
    const label = document.createElement("label");
    if (item.blocked !== undefined) {
      // 채움이 건너뛰거나 거절할 모양이다: 지우지 않고 표시한다
      label.classList.add("blocked");
      label.title = `채울 수 없는 모양입니다(${item.blocked})`;
    }
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `${list.id}-choice`;
    radio.addEventListener("change", () => onChoose(i));
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = d.kind;
    label.append(radio, kind, document.createTextNode(d.text));
    if (item.blocked !== undefined) {
      const badge = document.createElement("span");
      badge.className = "badge-blocked";
      badge.textContent = `채울 수 없음 ${item.blocked}`;
      label.appendChild(badge);
    }
    const sub = [item.extra ?? "", d.sub].filter((x) => x !== "").join(" · ");
    if (sub !== "") {
      const s = document.createElement("span");
      s.className = "sub";
      s.textContent = sub;
      label.appendChild(s);
    }
    li.appendChild(label);
    list.appendChild(li);
  });
}

function choose(view: DraftView | undefined): void {
  if (view === undefined) delete state.chosen;
  else state.chosen = view;
  els.fill.disabled = view === undefined || state.session === undefined;
  refreshMarks();
}

function showDrafts(drafts: DraftView[]): void {
  choose(undefined);
  renderChoices(els.drafts, drafts, (i) => choose(drafts[i]));
  // 기본 선택 규칙은 choice.ts: 막힌(blocked) 초안은 고르지 않고, 문단 초안은 그것만 있을 때만 고른다
  const at = defaultDraftIndex(drafts);
  const radio = at === undefined ? undefined : els.drafts.querySelectorAll<HTMLInputElement>("input")[at];
  if (at !== undefined && radio !== undefined) {
    radio.checked = true;
    choose(drafts[at]);
  }
}

function showMarksList(): void {
  renderChoices(
    els.marks,
    state.marks.map((m) => ({ anchor: m.anchor, mark: m.mark, extra: m.evidence })),
    (i) => {
      const m = state.marks[i];
      if (m === undefined) return;
      // 강조된 자리를 고르면 그 앵커가 채우기 대상이 된다(앵커 초안 목록에도 보인다)
      const view: DraftView = m.mark === undefined ? { anchor: m.anchor } : { anchor: m.anchor, mark: m.mark };
      renderChoices(els.drafts, [view], () => choose(view));
      const radio = els.drafts.querySelector<HTMLInputElement>("input");
      if (radio !== null) radio.checked = true;
      choose(view);
    },
  );
}

function resetPanel(): void {
  els.region.textContent = "-";
  els.address.textContent = "-";
  els.precision.textContent = "-";
  els.note.textContent = "";
  els.drafts.replaceChildren();
  els.fillOut.replaceChildren();
  delete state.pick;
  picks.cancel();
  choose(undefined);
}

async function loadSession(session: OpenResponse, keepScroll: boolean): Promise<void> {
  const scrollY = window.scrollY;
  const res = await fetch(`/api/session/${session.session}/bytes`);
  if (!res.ok) throw new Error("문서 바이트를 받지 못했습니다.");
  const doc = openDocument(new Uint8Array(await res.arrayBuffer()));
  state.view?.destroy();
  state.doc?.free();
  picks.cancel();
  const previous = state.session?.session;
  state.session = session;
  state.doc = doc;
  state.view = createPageView({
    container: els.pages,
    doc,
    scale: Number(els.scale.value) / 100,
    onPick: (e) => void onPick(e),
    onError: (e) => setStatus(String(e instanceof Error ? e.message : e), true),
  });
  // 새 문서를 열었으니 이전 세션은 서버에서 닫는다(같은 세션을 다시 불러온 경우는 그대로 둔다)
  void closeReplaced(previous, session.session, (id) => api(`/api/session/${id}`, { method: "DELETE" }));
  els.download.href = `/api/session/${session.session}/download`;
  els.download.classList.remove("disabled");
  els.reset.disabled = false;
  const marks = await api<MarksResponse>(`/api/session/${session.session}/marks`);
  state.marks = marks.marks;
  showMarksList();
  refreshMarks();
  if (keepScroll) window.scrollTo(0, scrollY);
  setStatus(`${session.label}: ${doc.pageCount()}쪽, 구역 ${session.sections}, 세대 ${session.generation}`);
}

async function openFixture(name: string): Promise<void> {
  resetPanel();
  const session = await post<OpenResponse>("/api/open", { fixture: name });
  await loadSession(session, false);
}

async function openUpload(file: File): Promise<void> {
  resetPanel();
  const session = await api<OpenResponse>("/api/open", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: await file.arrayBuffer() });
  await loadSession(session, false);
}

// ── 클릭·끌기 ────────────────────────────────────────────────────

/** 위치를 내지 않는 누름(limit: none)의 안내 */
function noneNote(e: PickEvent): string {
  switch (e.reason) {
    case "OVERLAPPING_RUNS":
      return "다른 문단의 글자가 겹쳐 그려진 자리라 어느 글자인지 정할 수 없습니다(OVERLAPPING_RUNS).";
    case "UNPOSITIONED_TEXT":
      return "문서 좌표 없이 그려진 글(쪽 번호·번호 글·각주 번호 등)이라 위치를 옮기지 않습니다(UNPOSITIONED_TEXT).";
    case "NEAREST_UNCONFIRMED":
      return "글자가 없는 곳이고, rhwp가 가리킨 문단이 점에서 가장 가까운 줄의 문단인지 확인하지 못해 옮기지 않습니다(NEAREST_UNCONFIRMED).";
  }
  return e.hit.region === "object"
    ? "개체(그림 등)를 눌렀습니다. 글자 위치가 아니라 엔진 주소로 옮기지 않습니다."
    : e.hit.region === "masterpage"
      ? "바탕쪽 글을 눌렀습니다. 바탕쪽은 본문이 아니므로 엔진 주소로 옮기지 않습니다."
      : "머리말·꼬리말·각주 안의 위치를 엔진 주소로 옮기는 것은 다음 단계입니다(영역만 알려 줍니다).";
}

const reasonNote = (precision: LocateResponse["precision"], reason: string): string =>
  precision === "none" ? `옮기지 못한 사유: ${reason}` : reason === "NEAREST_LINE" ? "글자가 없는 곳이라 가장 가까운 줄의 문단까지만 옮겼습니다(NEAREST_LINE)." : `문단 단위로 내려간 사유: ${reason}`;

async function onPick(e: PickEvent): Promise<void> {
  const session = state.session;
  if (session === undefined) return;
  const ticket = picks.begin();
  const { hit } = e;
  els.region.textContent = REGION[hit.region];
  els.fillOut.replaceChildren();
  delete state.pick;
  // 표 칸의 빈 곳은 위치 없이 칸(과 칸 안 줄 후보)만 보낸다: 서버가 엔진 표·행·열로 칸의 문단을 찾는다
  if (e.limit === "none" || (hit.position === undefined && e.cell === undefined)) {
    els.address.textContent = "-";
    els.precision.textContent = e.reason === undefined ? "-" : PRECISION.none;
    els.note.textContent = noneNote(e);
    showDrafts([]);
    refreshMarks();
    return;
  }
  // 응답을 기다리는 동안 이전 클릭의 주소·초안이 남아 채우기가 이전 자리에 적용되지 않게 먼저 비운다
  els.address.textContent = "…";
  els.precision.textContent = "…";
  els.note.textContent = "";
  showDrafts([]);
  const from: LocatePoint = {};
  if (e.cell !== undefined) from.cell = e.cell; // 칸이 줄 후보(위치·글)를 담고 있다
  else {
    if (hit.position !== undefined) from.position = hit.position;
    if (e.shown !== undefined) from.shown = e.shown;
    if (e.guide && e.guideText !== undefined) from.guide = e.guideText;
    if (e.trailing === true) from.trailing = true;
    if (e.limit === "paragraph") from.limit = "paragraph";
    if (e.reason !== undefined) from.reason = e.reason;
  }
  const request: LocateRequest = { from };
  if (e.to !== undefined) {
    const to: LocatePoint = { position: e.to.position };
    if (e.to.shown !== undefined) to.shown = e.to.shown;
    if (e.to.limit === "paragraph") to.limit = "paragraph";
    if (e.to.reason !== undefined) to.reason = e.to.reason;
    request.to = to;
  }
  try {
    const r = await post<LocateResponse>(`/api/session/${session.session}/locate`, request);
    if (!picks.current(ticket)) return; // 더 나중에 누른 점이나 문서 교체가 있었다: 이 응답은 낡았다
    els.address.textContent = r.address === undefined ? "-" : `구역 ${r.address.sectionIndex}, 문단 [${r.address.path.join(", ")}]${r.address.offset === undefined ? "" : `, 오프셋 ${r.address.offset}`}${r.trail.length > 0 ? `  (${r.trail.join(" > ")})` : ""}`;
    els.precision.textContent = PRECISION[r.precision];
    els.note.textContent = r.reason === undefined ? "" : reasonNote(r.precision, r.reason);
    // 표 셀과 글상자는 화면만으로는 가를 수 없으므로 서버가 준 지나온 컨테이너로 영역 이름을 바로잡는다
    const last = r.trail[r.trail.length - 1];
    if (hit.region === "cell" && last !== undefined) els.region.textContent = last === "tbl" ? "표 셀" : last.endsWith(":caption") ? "캡션" : REGION.textbox;
    if (r.precision === "char" && hit.position !== undefined) {
      if (e.guide && e.guideText !== undefined) state.pick = { id: "pick", kind: "pick", position: hit.position, endOffset: hit.position.charOffset, guide: e.guideText };
      else {
        // 누른 글자 자신(범위면 두 경계 사이)을 강조한다
        const caret = hit.position.charOffset;
        const other = e.to?.position.charOffset;
        const a = other === undefined ? (e.glyph ?? caret) : Math.min(caret, other);
        const b = other === undefined ? a + 1 : Math.max(caret, other);
        state.pick = { id: "pick", kind: "pick", position: { ...hit.position, charOffset: a }, endOffset: b };
      }
    }
    showDrafts(r.drafts);
    refreshMarks();
  } catch (error) {
    if (picks.current(ticket)) setStatus(String(error instanceof Error ? error.message : error), true);
  }
}

// ── 채우기 ───────────────────────────────────────────────────────

async function doFill(): Promise<void> {
  const session = state.session;
  const chosen = state.chosen;
  if (session === undefined || chosen === undefined) return;
  els.fill.disabled = true;
  picks.cancel();
  try {
    const r = await post<FillResponse>(`/api/session/${session.session}/fill`, { fills: [{ anchor: chosen.anchor, value: els.value.value }] });
    els.fillOut.replaceChildren();
    const head = document.createElement("div");
    head.className = r.ok ? "ok" : "bad";
    head.textContent = r.ok
      ? `채움 성공(저장 게이트 통과): ${r.summary.actions.map((a) => `${a.type} ${a.targets}곳`).join(", ")}`
      : r.code === "FILL_NOTHING_APPLIED"
        ? "채움 실패(FILL_NOTHING_APPLIED): 적용된 채움이 없습니다. 문서는 바뀌지 않았습니다 — 아래 건너뜀 사유를 보십시오."
        : "채움 실패: 저장 게이트가 막았거나 건너뛴 자리가 있습니다.";
    els.fillOut.appendChild(head);
    const list = document.createElement("ul");
    for (const s of r.summary.skipped) list.append(Object.assign(document.createElement("li"), { textContent: `건너뜀 ${s.code}: ${s.message}` }));
    for (const i of r.issues) list.append(Object.assign(document.createElement("li"), { textContent: `${i.severity === "error" ? "오류" : "경고"} ${i.code}: ${i.message}` }));
    els.fillOut.appendChild(list);
    if (r.ok) {
      await loadSession({ ...session, generation: r.generation, bytes: r.bytes }, true);
      delete state.pick;
      choose(undefined);
      refreshMarks();
    }
  } catch (error) {
    setStatus(String(error instanceof Error ? error.message : error), true);
  } finally {
    els.fill.disabled = state.chosen === undefined;
  }
}

// ── 시작 ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  setStatus("rhwp를 불러오는 중…");
  await loadRhwp({ wasmUrl: "/vendor/rhwp/rhwp_bg.wasm" });
  const list = await api<FixtureList>("/api/fixtures");
  for (const name of list.names) els.fixture.add(new Option(name, name));
  els.openFixture.addEventListener("click", () => void openFixture(els.fixture.value).catch((e) => setStatus(String(e instanceof Error ? e.message : e), true)));
  els.file.addEventListener("change", () => {
    const file = els.file.files?.[0];
    if (file !== undefined) void openUpload(file).catch((e) => setStatus(String(e instanceof Error ? e.message : e), true));
  });
  els.scale.addEventListener("input", () => {
    els.scaleOut.textContent = `${els.scale.value}%`;
    state.view?.setScale(Number(els.scale.value) / 100);
  });
  els.showMarks.addEventListener("change", refreshMarks);
  els.fill.addEventListener("click", () => void doFill());
  els.reset.addEventListener("click", () => {
    const session = state.session;
    if (session === undefined) return;
    resetPanel();
    void post<OpenResponse>(`/api/session/${session.session}/reset`, {})
      .then((s) => loadSession(s, true))
      .catch((e) => setStatus(String(e instanceof Error ? e.message : e), true));
  });
  setStatus("시험 문서를 고르거나 파일을 올리세요.");
}

main().catch((e) => setStatus(String(e instanceof Error ? e.message : e), true));
