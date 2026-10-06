// playwright-cli run-code --filename=apps/studio-lite/tools/check-layout-a.js
// Synthetic TXT only. The real-document pass uses the same upload -> file input path.
async page=>{
  const assert=(ok,message)=>{if(!ok)throw Error(message)};
  await page.reload();
  const content=await page.evaluate(()=>btoa('Project: {{project}}\nAmount: {{amount}}\nUnchanged'));
  const response=await page.request.post(await page.evaluate(()=>location.origin+'/api/workbench/open'),{data:{name:'layout-check.txt',content}});
  assert(response.ok(),'upload');const opened=await response.json();
  await page.evaluate(async url=>{const response=await fetch(url),transfer=new DataTransfer();transfer.items.add(new File([await response.blob()],'layout-check.txt'));const input=document.querySelector('#document-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));},opened.sourceUrl);
  await page.waitForFunction(()=>document.querySelectorAll('.rec-line').length===2&&!document.body.classList.contains('busy'));
  const source=await page.locator('.source-text').allTextContents();
  for(const width of [1366,1024]){await page.setViewportSize({width,height:768});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');assert(await page.locator('.main-actions').innerText()==='열기\n저장\n생성','top actions');}
  const first=page.locator('.rec-line').first();await first.locator('input').uncheck();assert((await first.innerText()).includes('제외'),'exclude');await page.locator('#review-undo').click();assert(await first.locator('input').isChecked(),'undo');
  await page.locator('.group-actions button').first().click();assert(await page.locator('.rec-line.excluded').count()===2,'group exclude');await page.locator('.group-actions button').nth(1).click();assert(await page.locator('.rec-line.excluded').count()===0,'group restore');
  await first.locator('button').click();await page.locator('#selection-remote').waitFor({state:'visible'});assert(await page.locator('#selection-remote [data-action]').count()===4,'remote actions');
  await page.locator('#remote-name').fill('project');await page.locator('#remote-name').press('Enter');assert(await page.locator('#selection-remote').isHidden(),'Enter confirmation');await page.locator('#detail-name').fill('Display name');await page.locator('#detail-toggle').click();await page.locator('#detail-toggle').click();assert(await page.locator('#detail-name').inputValue()==='Display name','draft retained');
  await page.locator('#document-editor').click({button:'right'});assert(await page.locator('#context-menu').isVisible(),'context menu');assert(await page.locator('#context-menu [data-action=branchDetail]').isDisabled(),'unsupported reason');await page.keyboard.press('Escape');
  assert(JSON.stringify(await page.locator('.source-text').allTextContents())===JSON.stringify(source),'source unchanged');assert(await page.locator('.line-number').count()===3,'TXT line numbers');
  const originalText=await page.locator('#document-editor').inputValue();
  await page.locator('#document-editor').evaluate(el=>{el.setSelectionRange(0,7);el.dispatchEvent(new Event('select'));});
  for(const level of [1,2]){if(!await page.locator('.tools-menu').evaluate(e=>e.open))await page.locator('.tools-menu > summary').click();const button=page.locator('[data-action=heading'+level+']');assert(await button.isEnabled(),'TXT heading enabled');await button.click();assert(await page.locator('.heading-unit').count()===1,'TXT heading applied');assert(await page.locator('#document-editor').inputValue()===originalText,'heading preserves plain text');}
  await page.locator('.tools-menu > summary').click();await page.locator('#undo').click();await page.locator('#undo').click();assert(await page.locator('.heading-unit').count()===0,'heading undo');assert((await page.locator('#copy-body').getAttribute('title')).includes('다시 생성'),'stale copy reason');
  await page.locator('#library-tab').click();assert(await page.locator('#library-list').isVisible(),'library tab');await page.locator('#document-tab').click();
  await page.locator('#txt-missing').selectOption('keep',{force:true});
  await page.locator('#generate').click();await page.waitForFunction(()=>!document.body.classList.contains('busy'));assert(await page.locator('#copy-body').isEnabled(),'TXT result can be copied');assert(await page.locator('#document-editor').isVisible(),'TXT stays in editor');assert(await page.locator('.original-pane').isHidden(),'TXT has no viewer');assert(await page.locator('.editor-pane').isVisible(),'TXT editor restored');
  for(let i=0;i<12;i++){
    const response=page.waitForResponse(r=>r.url().endsWith('/api/workbench/compare'));
    await page.evaluate(i=>{const transfer=new DataTransfer();transfer.items.add(new File(['Comparison '+i],'comparison.txt'));const input=document.querySelector('#compare-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));},i);
    assert((await response).ok(),'comparison route');await page.waitForFunction(()=>!document.body.classList.contains('busy'));assert(await page.locator('.original-pane').isVisible(),'TXT comparison visible');
  }
  await page.locator('#generate').click();await page.waitForFunction(()=>!document.body.classList.contains('busy'));assert(await page.locator('#download').getAttribute('aria-disabled')==='false','source session survives 12 comparisons');
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/workbench/save'));await page.locator('#save-work').click();assert((await saved).ok(),'save after comparisons');
  await page.evaluate(()=>document.body.dataset.layoutRegression='pass: two sizes, review exclude/undo/group, remote/context, draft, TXT, source, tabs');
}
