// 첫 캠페인에서 나온 결함·거절을 합성 최소 문서로 재현한다. 실제 문서를 쓰지 않는다.
// 실행: node tools/stress/repro.ts   (각 줄에 재현됨 여부를 낸다. 엔진이 고쳐지면 "재현되지 않음"이 된다)
// 캠페인에 따른 수정(명세 7.8) 뒤: D3(목록 없음 거절)은 재현되지 않는다. D1·D2의 검사기 새 오류는 소스 원문을 그대로 옮긴 결과라 여전히 보이지만,
// 계획의 inherited가 이를 설명한다("상속 기록으로 설명되지 않는 새 오류"가 재현되지 않음).
import {
  HwpxError,
  applyPlan,
  extractFragment,
  planImport,
  type HwpxDocument,
} from "../../packages/hwpx-engine/src/index.ts";
import { explainInherited } from "../../packages/hwpx-engine/src/fill/index.ts";
import { compareToBaseline, validateDocument } from "../../packages/hwpx-engine/src/validate/index.ts";
import { MINIMAL_HEADER, buildHwpx, parseSynthetic, reparse } from "../../packages/hwpx-engine/test/helpers.ts";

const para = (id: string, inner: string, text = "x"): string =>
  `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${inner}<hp:t>${text}</hp:t></hp:run></hp:p>`;

/** 소스 전체 문단을 대상 끝에 넣고 새 검사 오류를 낸다. `unexplained`는 계획의 inherited로 설명되지 않는 새 오류다. */
function importAtEnd(src: HwpxDocument, tgt: HwpxDocument): { newErrors: string[]; unexplained: string[]; error?: string } {
  try {
    const last = (tgt.sections[0]?.paragraphs.length ?? 1) - 1;
    const fragment = extractFragment(src, { sectionIndex: 0, parentPath: [], from: 0, to: (src.sections[0]?.paragraphs.length ?? 1) - 1 });
    const plan = planImport(tgt, fragment, { sectionIndex: 0, parentPath: [], index: last, position: "after" });
    const bytes = applyPlan(tgt.pkg, plan);
    reparse(bytes);
    const cmp = compareToBaseline(validateDocument(tgt.pkg.bytes), validateDocument(bytes));
    const show = (list: { code: string; message: string }[]): string[] => list.map((e) => `${e.code}: ${e.message}`);
    return { newErrors: show(cmp.newErrors), unexplained: show(explainInherited(cmp.newErrors, plan.inherited).unexplained) };
  } catch (e) {
    return { newErrors: [], unexplained: [], error: e instanceof HwpxError ? e.code : String(e) };
  }
}

const show = (name: string, reproduced: boolean, detail: string): void => {
  process.stdout.write(`${reproduced ? "재현됨    " : "재현되지 않음"}  ${name}  ${detail}\n`);
};

// 1) 소스 조각 안의 객체 id 중복(드로잉 개체 그룹의 자식 id 1, 2가 그룹마다 되풀이되는 모양): 대상과 겹치지 않아도 중복이 그대로 옮겨진다.
{
  const src = parseSynthetic([para("1", `<hp:rect id="2"/><hp:rect id="2"/>`)]);
  const tgt = parseSynthetic([para("1", `<hp:rect id="100"/>`)]);
  const r = importAtEnd(src, tgt);
  show("D1 소스 조각 안의 객체 id 중복이 그대로 옮겨짐", r.newErrors.some((e) => e.startsWith("INST_DUP_ID") && e.includes("object id")), r.newErrors.join(" | "));
  show("D1 상속 기록으로 설명되지 않는 새 오류(게이트가 막는 것)", r.unexplained.length > 0, r.unexplained.join(" | "));
}

// 2) 소스 조각 안의 문단 id 중복(자리값이 아닌 id가 두 문단에 있다): 대상에 그 id가 없으면 재발급하지 않아 중복이 그대로 옮겨진다.
{
  const src = parseSynthetic([para("7", "", "a") + para("7", "", "b")]);
  const tgt = parseSynthetic([para("1", "")]);
  const r = importAtEnd(src, tgt);
  show("D2 소스 조각 안의 문단 id 중복이 그대로 옮겨짐", r.newErrors.some((e) => e.startsWith("INST_DUP_ID") && e.includes("paragraph id")), r.newErrors.join(" | "));
  show("D2 상속 기록으로 설명되지 않는 새 오류(게이트가 막는 것)", r.unexplained.length > 0, r.unexplained.join(" | "));
  // 대조: 같은 id가 대상에도 있으면 재발급된다(문단 id 재발급 수정이 동작하는 경우)
  const tgt2 = parseSynthetic([para("7", "")]);
  const r2 = importAtEnd(src, tgt2);
  show("D2' (대조) 대상에 같은 문단 id가 있으면 재발급되어 새 오류 없음", r2.newErrors.length === 0, r2.newErrors.join(" | "));
}

// 3) 대상 header에 bullets 목록이 없으면 글머리표 문단모양이 든 조각을 거절했다(FRAG_NO_LIST). 이제는 목록을 만든다.
{
  const srcHeader = MINIMAL_HEADER.replace(
    "<hh:paraProperties itemCnt=\"1\">",
    '<hh:bullets itemCnt="1"><hh:bullet id="1" char="&#8226;" useImage="0"/></hh:bullets><hh:paraProperties itemCnt="2">',
  ).replace("</hh:paraProperties>", '<hh:paraPr id="1"><hh:heading type="BULLET" idRef="1" level="0"/><hh:border borderFillIDRef="1"/></hh:paraPr></hh:paraProperties>');
  const src = reparse(buildHwpx([`<hp:p id="1" paraPrIDRef="1" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>x</hp:t></hp:run></hp:p>`], srcHeader));
  const tgt = parseSynthetic([para("1", "")]);
  const r = importAtEnd(src, tgt);
  show("D3 대상 header에 bullets 목록이 없으면 거절(FRAG_NO_LIST)", r.error === "FRAG_NO_LIST", r.error ?? `거절되지 않음(새 오류 ${r.newErrors.length}건)`);
}

// 4) 소스에서 이미 없는 대상(탭 목록 3번)을 가리키는 문단모양은, 대상에 같은 id의 탭 목록이 있으면 그 자원을 가리키게 되고(대상 쪽의 없는 참조를 채우는 일과는 다른, 소스 쪽 사정),
//    같은 조각을 두 번째 가져올 때는 지문이 달라 자원이 또 추가된다(명세 7.65: 소스에서 없는 대상을 가리키던 참조는 그대로 옮긴다).
{
  const srcHeader = MINIMAL_HEADER.replace('<hh:paraProperties itemCnt="1">', '<hh:paraProperties itemCnt="2">').replace(
    "</hh:paraProperties>",
    '<hh:paraPr id="1" tabPrIDRef="3"><hh:heading type="NONE" idRef="0" level="0"/><hh:border borderFillIDRef="1"/></hh:paraPr></hh:paraProperties>',
  );
  const src = reparse(buildHwpx([`<hp:p id="1" paraPrIDRef="1" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>x</hp:t></hp:run></hp:p>`], srcHeader));
  const tgtHeader = MINIMAL_HEADER.replace(
    "<hh:paraProperties",
    '<hh:tabProperties itemCnt="1"><hh:tabPr id="3" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties><hh:paraProperties',
  );
  const tgt = parseSynthetic([para("1", "")], tgtHeader);
  const fragment = extractFragment(src, { sectionIndex: 0, parentPath: [], from: 0, to: 0 });
  show("D4 소스의 없는 참조(탭 목록 3번)가 조각 경고(FRAG_DANGLING_SOURCE)로 남음", fragment.issues.some((i) => i.code === "FRAG_DANGLING_SOURCE"), fragment.issues.map((i) => i.code).join(","));
  const end = { sectionIndex: 0, parentPath: [], index: 0, position: "after" as const };
  const once = reparse(applyPlan(tgt.pkg, planImport(tgt, fragment, end)));
  const second = planImport(once, fragment, { ...end, index: (once.sections[0]?.paragraphs.length ?? 1) - 1 });
  show("D4 같은 조각을 두 번째 가져올 때 자원이 또 추가됨(지문이 달라 재사용되지 않음)", (second.summary["addedResources"] ?? 0) > 0, `addedResources=${second.summary["addedResources"]}`);
}
