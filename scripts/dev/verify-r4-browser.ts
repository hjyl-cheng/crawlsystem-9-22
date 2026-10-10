import {chromium,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
const token=await issueToken({subject:'r4-browser-acceptance',workspace_id:'m1-main',role:'operator'},loadSigningKey(),600);
const browser=await chromium.launch({headless:true}),errors:string[]=[];
try {
  const page=await browser.newPage({viewport:{width:1586,height:992},extraHTTPHeaders:{authorization:`Bearer ${token}`}});
  page.on('pageerror',error=>errors.push(error.name));
  for(const mode of ['full','reject']) {
    const state=JSON.parse(readFileSync(`.runtime/r4/${mode}-state.json`,'utf8'));
    await page.goto(`http://127.0.0.1:18103/plans/${state.plan_id}`);
    await expect(page.getByRole('heading',{name:'采集与入库进度',exact:true})).toBeVisible();
    if(mode==='reject') {
      await expect(page.getByText('本轮已结束：订阅门槛未通过，频道资料已保存，视频和画像未执行。',{exact:true})).toBeVisible();
      await expect(page.getByText('未执行：订阅门槛未通过',{exact:true})).toHaveCount(2);
      await expect(page.getByText('等待清单或入库',{exact:true})).toHaveCount(0);
    }else await expect(page.getByText('本轮采集与入库已完成。',{exact:true})).toBeVisible();
    await page.screenshot({path:`.runtime/r4/${mode}-plan.png`,fullPage:true});
    await page.goto('http://127.0.0.1:18103/discover/candidates');
    await page.getByRole('textbox',{name:'搜索候选'}).fill(state.channel_id);
    const row=page.locator('.query-list tbody tr').first();
    await expect(row).toContainText(state.channel_id);
    await expect(row).toContainText(mode==='reject'?'订阅门槛未通过，已停止后续采集':'订阅门槛已通过');
    await page.screenshot({path:`.runtime/r4/${mode}-candidate.png`,fullPage:true});
  }
  await page.goto('http://127.0.0.1:18103/discover');
  await expect(page.getByText('已验证合格 / 待结算搜索',{exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'搜索搜索词'}).fill('Google Developers tutorials');
  await expect(page.locator('.query-list tbody tr').first()).toContainText('合格 1');
  await page.screenshot({path:'.runtime/r4/discover.png',fullPage:true});
  expect(errors).toEqual([]);
  const result={result:'PASSED',pages:['full-plan','rejected-plan','full-candidate','rejected-candidate','discover'],runtime_errors:errors.length,automatic_search:false,automatic_admission:false,automatic_updates:false,verified_at:new Date().toISOString()};
  writeFileSync('.runtime/r4/browser-evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
