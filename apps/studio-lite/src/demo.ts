import type { Project } from './model.ts';
export function demo(): Project {
  return {
    version:1,name:'구매 공고 템플릿',mode:'markdown',
    markdown:'# 물품 구매 공고\n\n사업명: {{사업명}}\n계약금액: {{계약금액}}\n계약방법: {{계약방법}}\n\n## 참가자격\n\n[IN_TEMPLATE:qualification]\n\n## 계약 안내\n\n[IN_TEMPLATE:contract]\n\n| 항목 | 내용 |\n| --- | --- |\n| 납품 장소 | {{납품장소}} |\n| 납품 기한 | 계약일로부터 30일 |',
    sources:[],fields:[],ranges:[],
    records:[
      {사업명:'전산장비 구매',계약금액:'120,000,000원',계약방법:'제한경쟁',납품장소:'수요기관 지정 장소',중소기업:true,직접생산:true},
      {사업명:'회의실 모니터 구매',계약금액:'35,000,000원',계약방법:'일반경쟁',납품장소:'본관 3층 회의실',중소기업:true,직접생산:false},
      {사업명:'사무용 비품 구매',계약금액:'8,000,000원',계약방법:'일반경쟁',납품장소:'본관 물품창고',중소기업:false,직접생산:false},
    ],
    blocks:[
      {id:'direct',group:'qualification',alias:'직접생산',engine_type:'markdown',condition:'중소기업=true AND 직접생산=true',priority:20,content:'- 중소기업 확인서를 보유한 업체\n- 해당 물품의 직접생산 확인이 가능한 업체\n- 입찰 마감일까지 자격을 유지하여야 합니다.'},
      {id:'sme',group:'qualification',alias:'중소기업',engine_type:'markdown',condition:'중소기업=true',priority:10,content:'- 유효한 중소기업 확인서를 보유한 업체\n- 공고에서 정한 납품 조건을 충족하는 업체'},
      {id:'general',group:'qualification',alias:'일반',engine_type:'markdown',condition:'',priority:0,content:'- 해당 사업에 필요한 자격을 갖춘 업체\n- 공고에서 정한 납품 조건을 충족하는 업체'},
      {id:'standard',group:'contract',alias:'표준 계약',engine_type:'markdown',condition:'',priority:0,content:'계약상대자는 계약 체결 후 지정한 기한 내에 {{사업명}}에 필요한 물품을 납품합니다.\n\n※ 이 문서는 기능 확인용 예시입니다.'},
    ],
  };
}
export const demoSources = [
  {id:'sample-a',name:'구매 공고 A.md',kind:'md' as const,content:'# 물품 구매 공고\n\n사업명: 서버 구매\n계약금액: 금 120,000,000원\n계약방법: 제한경쟁\n참가자격: 직접생산 확인서를 보유한 중소기업\n\n납품장소: 본관 전산실'},
  {id:'sample-b',name:'구매 공고 B.md',kind:'md' as const,content:'# 물품 구매 공고\n\n사업명: 모니터 구매\n계약금액: 금 35,000,000원\n계약방법: 일반경쟁\n참가자격: 납품 가능한 일반 업체\n\n납품장소: 본관 회의실'},
];
