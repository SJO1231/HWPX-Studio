// Run with playwright-cli run-code --filename=... after opening the static layout-a.html.
// Uses synthetic UI values only. Product HWPX upload/drag is checked separately.
async page => {
{

 const eq=(a,b,label)=>{if(a!==b)throw Error(label)};
 await page.reload();await page.setViewportSize({width:1024,height:768});await page.getByRole('button',{name:'공고서 사본 열기',exact:true}).click();
 const source=await page.locator('#paperScroll .paper').textContent();
 await page.locator('[data-rec-check="project"]').uncheck();eq(await page.locator('#paperScroll .paper').textContent(),source,'Q1 excluded');
 await page.locator('#rail [data-action="undo"]').click();eq(await page.locator('#paperScroll .paper').textContent(),source,'Q1 undo');
 await page.locator('[data-part="project"]').click();await page.locator('#fieldName').fill('업무 이름');await page.getByRole('button',{name:'입력 항목으로 확정',exact:true}).click();eq(await page.locator('#paperScroll .paper').textContent(),source,'Q1 connected');
 await page.locator('.stage-footer .primary[data-action="step"]').click();if(!await page.locator('#saveName').isVisible())throw Error('Q6 did not skip');
 await page.getByRole('button',{name:'템플릿 저장 · 모의',exact:true}).click();await page.locator('.stage-footer [data-step="5"]').click();await page.getByRole('button',{name:'바로 생성 · 모의',exact:true}).click();await page.getByRole('button',{name:'결과 TXT 내려받기 · 모의',exact:true}).waitFor();
 await page.getByRole('button',{name:'원문',exact:true}).click();eq(await page.locator('#paperScroll .paper').textContent(),source,'Q1 generated source');
 await page.locator('#businessCase').selectOption('case-b');await page.getByRole('button',{name:'바로 생성 · 모의',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#businessCase').disabled&&document.querySelector('[data-action="generate"]').disabled===false);
 eq(await page.locator('#paperScroll .paper').textContent(),source,'Q1 different record');
 await page.getByRole('button',{name:'바로 생성 · 모의',exact:true}).click();if((await page.locator('#paperScroll .paper').textContent())===source)throw Error('Q3 preview did not change');
 await page.getByRole('button',{name:'원문',exact:true}).click();eq(await page.locator('#paperScroll .paper').textContent(),source,'Q3 source changed');
 await page.setViewportSize({width:1366,height:768});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('overflow');
 await page.evaluate(()=>document.body.dataset.qMock='source-exclude-undo-connect-zero-branch-save-generate-record-preview-pass');

}
{

 await page.reload();await page.getByRole('button',{name:'공고서 사본 열기',exact:true}).click();
 const source=await page.locator('#paperScroll .paper').textContent();
 const equalSource=async label=>{if(await page.locator('#paperScroll .paper').textContent()!==source)throw Error(label)};
 await page.locator('[data-point="qualification"]').click({button:'right'});await page.locator('#remote [data-id="branch"]').click();await page.locator('#remoteName').fill('참가자격 분기');await page.locator('#remoteName').press('Enter');await equalSource('Q1 branch creation');
 if(!await page.locator('.detail [data-matrix-point="qualification"]').first().isVisible())throw Error('Q7 no branch detail');
 await page.locator('.detail [data-matrix-point="qualification"][data-case="sme-single"]').selectOption('general');await equalSource('Q1 block selection');
 await page.locator('#rail [data-action="branches-large"]').click();await page.locator('#dialog [data-scenario="sme-single"][data-condition="중소기업"]').selectOption('비해당');await page.locator('#dialog [data-scenario="sme-single"][data-condition="납품유형"]').selectOption('분할');await page.getByRole('button',{name:'원래 위치로',exact:true}).click();await equalSource('Q10 conditions');
 await page.locator('#rail [data-action="branches-large"]').click();if(!((await page.locator('#dialog .scenario-routing').textContent()).includes('경우가 겹침')))throw Error('Q10 condition result not updated');await page.getByRole('button',{name:'원래 위치로',exact:true}).click();
 if(/중소기업=|AND|\[같음:/.test(source))throw Error('Q8 condition in source');
 await page.locator('.top-actions [data-action="open-menu"]').click();await page.getByRole('button',{name:'TXT 자리 표기',exact:true}).click();const txt=await page.locator('#txtExample').inputValue();if(!txt.includes('{{사업명}}')||!txt.includes('{{#참가자격}}')||!txt.includes('{{/참가자격}}'))throw Error('Q9 notation');await page.getByRole('button',{name:'닫기',exact:true}).click();
 await page.evaluate(()=>document.body.dataset.qConditions='source-branch-block-condition-routing-txt-notation-pass');

}
}
