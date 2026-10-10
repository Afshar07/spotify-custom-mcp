/** Single-file setup wizard UI. Dynamic text is only ever set via textContent. */
export const SETUP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spotify Curator Setup</title>
<style>
:root{--bg:#fff;--fg:#14171a;--muted:#5b6670;--card:#f4f6f8;--line:#d5dbe1;--accent:#12814a;--accent-fg:#fff;--bad:#b3261e;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#121416;--fg:#eef1f3;--muted:#a0abb5;--card:#1b1f23;--line:#333b42;--accent:#2fbf71;--accent-fg:#06210f;--bad:#ff8a80;--warn:#f0b04a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,Segoe UI,sans-serif}
main{max-width:40rem;margin:0 auto;padding:1.5rem 1rem 4rem}
h1{font-size:1.5rem;margin:.25rem 0 1rem}h2{font-size:1.2rem;margin:0 0 .5rem}
ol.steps{display:flex;gap:.25rem;list-style:none;padding:0;margin:0 0 1.25rem;flex-wrap:wrap}
ol.steps li{flex:1 1 5rem;font-size:.8rem;color:var(--muted);border-top:4px solid var(--line);padding-top:.25rem}
ol.steps li[aria-current=step]{color:var(--fg);border-color:var(--accent);font-weight:600}
ol.steps li.done{border-color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1rem;margin:.75rem 0}
button{font:inherit;padding:.6rem 1rem;border-radius:.5rem;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600}
button.big{font-size:1.15rem;padding:.9rem 1.5rem}button:disabled{opacity:.55;cursor:not-allowed}
button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
input[type=text]{font:inherit;width:100%;padding:.6rem;border-radius:.5rem;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
label{display:block;font-weight:600;margin:.5rem 0 .25rem}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-top:1rem}
.muted{color:var(--muted)}.bad{color:var(--bad)}.warn{color:var(--warn)}.ok{color:var(--accent)}
.status{display:flex;gap:.5rem;align-items:flex-start;margin:.35rem 0}.status b{min-width:1.2rem}
code{background:var(--bg);border:1px solid var(--line);border-radius:.3rem;padding:.1rem .35rem;word-break:break-all}
[hidden]{display:none!important}
.spin{display:inline-block;width:1em;height:1em;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:s 1s linear infinite;vertical-align:-.15em}
@keyframes s{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spin{animation:none}}
.client{display:flex;gap:.75rem;align-items:flex-start}.client input{margin-top:.4rem;width:1.2rem;height:1.2rem}
details{margin-top:.5rem}pre{white-space:pre-wrap;word-break:break-all}
</style>
</head>
<body>
<main>
<h1>Spotify Curator</h1>
<ol class="steps" id="steps" aria-label="Setup progress"></ol>
<div id="live" role="status" aria-live="polite" class="muted"></div>

<section id="s1" data-step="1" aria-labelledby="h1a">
  <h2 id="h1a">Welcome</h2>
  <p>Spotify Curator lets your AI assistant search Spotify, build playlists and organise them for you. Everything runs on this PC and your Spotify sign-in is stored securely for your Windows account only.</p>
  <div class="card" id="overview" aria-live="polite">Checking this PC…</div>
  <div class="row"><button class="primary" data-next>Get started</button></div>
</section>

<section id="s2" data-step="2" hidden aria-labelledby="h2a">
  <h2 id="h2a">Your Spotify app</h2>
  <p>Spotify needs a small "app" that you own. This is free and takes about two minutes.</p>
  <ol>
    <li>Open the <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener noreferrer">Spotify developer dashboard</a> and choose <b>Create app</b>.</li>
    <li>Under <b>Redirect URI</b> add exactly: <code id="redirect"></code> <button id="copyRedirect" type="button">Copy</button></li>
    <li>Tick <b>Web API</b> and save.</li>
    <li>Open the app's <b>User management</b> and add the Spotify account you will use (name and email). The app owner needs Spotify Premium, and Spotify allows up to 5 people per app.</li>
    <li>Copy the app's <b>Client ID</b> and paste it below. You do <u>not</u> need the Client Secret.</li>
  </ol>
  <label for="clientId">Client ID</label>
  <input type="text" id="clientId" autocomplete="off" spellcheck="false" aria-describedby="clientIdHelp clientIdError">
  <div id="clientIdHelp" class="muted">32 letters and numbers.</div>
  <div id="clientIdError" class="bad" role="alert"></div>
  <div class="row"><button data-back>Back</button><button class="primary" id="saveClientId">Continue</button></div>
</section>

<section id="s3" data-step="3" hidden aria-labelledby="h3a">
  <h2 id="h3a">Connect Spotify</h2>
  <p>Your browser will open Spotify so you can approve access. Spotify Curator never sees your password.</p>
  <div id="connectState" aria-live="polite"></div>
  <div id="connectError" class="bad" role="alert"></div>
  <div class="row">
    <button data-back>Back</button>
    <button class="primary big" id="connect">Connect Spotify</button>
    <button id="cancelConnect" hidden>Cancel</button>
    <button class="primary" id="next3" data-next hidden>Continue</button>
  </div>
  <details id="fallback" hidden><summary>Browser did not open?</summary><p>Copy this link into your browser:</p><pre id="fallbackUrl"></pre></details>
</section>

<section id="s4" data-step="4" hidden aria-labelledby="h4a">
  <h2 id="h4a">Choose your AI app</h2>
  <p>Pick where you want to use Spotify Curator. You can choose both.</p>
  <div id="clients"></div>
  <div class="row"><button data-back>Back</button><button class="primary" id="install">Set up selected apps</button></div>
</section>

<section id="s5" data-step="5" hidden aria-labelledby="h5a">
  <h2 id="h5a">Setting things up</h2>
  <div id="installResults" aria-live="polite"></div>
  <div class="row"><button data-back>Back</button><button class="primary" id="next5" data-next hidden>Continue</button></div>
</section>

<section id="s6" data-step="6" hidden aria-labelledby="h6a">
  <h2 id="h6a">Ready</h2>
  <div class="card" id="ready" aria-live="polite"></div>
  <div class="card"><b>Try it:</b> <i>"Show me my Spotify playlists, then preview a new 20-song playlist for a rainy Sunday without creating it."</i></div>
  <div class="row">
    <button id="test">Test connection</button>
    <button id="repair">Repair</button>
    <button id="disconnect">Disconnect Spotify</button>
  </div>
  <div id="testResults" class="card" hidden aria-live="polite"></div>
  <details><summary>Using another app?</summary><p>Add this to any app that supports local (stdio) MCP servers:</p><pre id="generic"></pre></details>
</section>
</main>
<script>
(function(){
var NAMES=['Welcome','Spotify app','Connect','AI app','Set up','Ready'];
var step=1,data=null,poll=null;
function $(id){return document.getElementById(id)}
function say(t){$('live').textContent=t||''}
function el(tag,text,cls){var e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e}
function api(path,body){
  var opt=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
  return fetch(path,opt).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Something went wrong.');return j})});
}
function renderSteps(){
  var ol=$('steps');ol.textContent='';
  NAMES.forEach(function(n,i){var li=el('li',(i+1)+'. '+n);if(i+1===step)li.setAttribute('aria-current','step');else if(i+1<step)li.className='done';ol.appendChild(li)});
}
function show(n){
  step=n;document.querySelectorAll('section').forEach(function(s){s.hidden=Number(s.dataset.step)!==n});
  renderSteps();var h=document.querySelector('section[data-step="'+n+'"] h2');if(h){h.setAttribute('tabindex','-1');h.focus()}
  if(n===6)loadReady();
}
function status(parent,ok,text,detail){
  var row=el('div',null,'status');row.appendChild(el('b',ok===true?'✓':ok===false?'✗':'•',ok===true?'ok':ok===false?'bad':'muted'));
  var box=el('div');box.appendChild(el('span',text));if(detail)box.appendChild(el('div',detail,'muted'));row.appendChild(box);parent.appendChild(row);
}
function load(){return api('/api/state').then(function(s){data=s;return s})}
function renderOverview(){
  var o=$('overview');o.textContent='';
  status(o,data.auth.state==='connected',data.auth.state==='connected'?'Spotify connected'+(data.auth.account&&data.auth.account.displayName?' as '+data.auth.account.displayName:''):'Spotify not connected yet');
  data.clients.forEach(function(c){
    var ready=c.registered&&c.upToDate;
    status(o,ready?true:null,c.name+': '+(ready?'set up':c.support==='unverified'?'manual setup only':c.installed==='installed'?'found, not set up yet':c.installed==='not_found'?'not found':'not set up yet'));
  });
  $('redirect').textContent=data.redirectUri;$('generic').textContent=data.genericConfig;
  if(data.clientId)$('clientId').value=data.clientId;
}
function renderClients(){
  var box=$('clients');box.textContent='';
  data.clients.forEach(function(c){
    var card=el('div',null,'card');var row=el('label',null,'client');row.style.fontWeight='400';
    var cb=document.createElement('input');cb.type='checkbox';cb.id='client-'+c.id;cb.value=c.id;
    cb.checked=c.id==='opencode';row.appendChild(cb);
    var txt=el('div');txt.appendChild(el('b',c.name));
    var tag=c.support==='supported'?'Automatic setup':'Manual setup only (not verified)';
    txt.appendChild(el('div',tag,c.support==='supported'?'ok':'warn'));
    txt.appendChild(el('div',c.detail,'muted'));
    if(c.conflicts&&c.conflicts.length){txt.appendChild(el('div','Another Spotify server is already set up here ('+c.conflicts.join(', ')+'). It will be switched off, not deleted.','warn'))}
    row.appendChild(txt);card.appendChild(row);box.appendChild(card);
  });
}
function selected(){return Array.prototype.slice.call(document.querySelectorAll('#clients input:checked')).map(function(i){return i.value})}

$('copyRedirect').onclick=function(){navigator.clipboard&&navigator.clipboard.writeText($('redirect').textContent).then(function(){say('Copied.')})};
$('saveClientId').onclick=function(){
  $('clientIdError').textContent='';var b=$('saveClientId');b.disabled=true;
  api('/api/client-id',{clientId:$('clientId').value}).then(function(){return load()}).then(function(){show(3)})
   .catch(function(e){$('clientIdError').textContent=e.message}).then(function(){b.disabled=false});
};
function setConnectUi(running){$('connect').hidden=running;$('cancelConnect').hidden=!running}
function renderJob(j){
  var s=$('connectState');s.textContent='';$('connectError').textContent='';
  if(j.authorizeUrl){$('fallback').hidden=false;$('fallbackUrl').textContent=j.authorizeUrl}
  if(j.state==='running'){var p=el('p');p.appendChild(el('span',null,'spin'));p.appendChild(document.createTextNode(' Waiting for you to approve access in your browser…'));s.appendChild(p);setConnectUi(true)}
  else if(j.state==='done'){clearInterval(poll);setConnectUi(false);$('connect').hidden=true;$('next3').hidden=false;status(s,true,'Connected to Spotify'+(j.account&&j.account.displayName?' as '+j.account.displayName:''));say('Spotify connected.')}
  else if(j.state==='error'){clearInterval(poll);setConnectUi(false);$('connect').textContent='Try again';$('connectError').textContent=j.error.message}
}
$('connect').onclick=function(){
  $('connectError').textContent='';$('fallback').hidden=true;
  api('/api/connect',{}).then(function(j){renderJob(j);clearInterval(poll);poll=setInterval(function(){api('/api/job').then(renderJob)},1000)})
   .catch(function(e){$('connectError').textContent=e.message});
};
$('cancelConnect').onclick=function(){api('/api/cancel',{})};
$('install').onclick=function(){
  var list=selected();if(!list.length){say('Choose at least one app.');return}
  show(5);var box=$('installResults');box.textContent='';$('next5').hidden=true;
  var p=el('p');p.appendChild(el('span',null,'spin'));p.appendChild(document.createTextNode(' Setting up and checking…'));box.appendChild(p);
  api('/api/install',{clients:list,disableConflicts:true}).then(function(r){
    box.textContent='';
    if(r.opencode){var o=r.opencode;
      if(o.verified)status(box,true,'OpenCode is ready','Spotify Curator started and listed '+o.toolCount+' tools.');
      else if(o.installed)status(box,false,'OpenCode was updated, but the check failed',(o.checks||[]).filter(function(c){return !c.ok}).map(function(c){return c.detail}).join(' ')+' Use Repair on the next screen.');
      else status(box,false,'OpenCode could not be set up',o.message);
    }
    var g=r['chatgpt-desktop'];if(g){status(box,null,'ChatGPT Desktop needs a manual step','Automatic setup is not verified for ChatGPT Desktop yet.');var ol=el('ol');(g.steps||[]).forEach(function(t){ol.appendChild(el('li',t))});box.appendChild(ol)}
    $('next5').hidden=false;
  }).catch(function(e){box.textContent='';status(box,false,'Setup failed',e.message);$('next5').hidden=false});
};
function loadReady(){
  var box=$('ready');box.textContent='Checking…';
  api('/api/diagnostics',{}).then(function(r){
    return load().then(function(){
      box.textContent='';
      status(box,data.auth.state==='connected','Spotify: '+(data.auth.state==='connected'?'connected'+(data.auth.account&&data.auth.account.displayName?' as '+data.auth.account.displayName:''):'not connected'));
      var oc=r.checks.filter(function(c){return c.id==='opencode'})[0];
      status(box,oc.status==='pass','OpenCode: '+(oc.status==='pass'?'ready':'needs attention'),oc.status==='pass'?null:oc.detail);
      status(box,null,'ChatGPT Desktop: manual setup only (not verified)');
      status(box,r.toolCount?true:false,'Spotify Curator '+data.version+(r.toolCount?' — '+r.toolCount+' tools available':''));
    });
  }).catch(function(e){box.textContent=e.message});
}
$('test').onclick=function(){
  var b=$('test'),box=$('testResults');b.disabled=true;box.hidden=false;box.textContent='Testing…';
  api('/api/diagnostics',{}).then(function(r){
    box.textContent='';r.checks.forEach(function(c){status(box,c.status==='pass'?true:c.status==='fail'?false:null,c.title,c.detail)});
    say(r.ok?'All checks passed.':'Some checks need attention.');
  }).catch(function(e){box.textContent=e.message}).then(function(){b.disabled=false});
};
$('repair').onclick=function(){
  var b=$('repair');b.disabled=true;say('Repairing…');
  api('/api/repair',{}).then(function(r){say(r.ok?'Repaired. Run "Test connection" to confirm.':r.message)}).catch(function(e){say(e.message)}).then(function(){b.disabled=false;loadReady()});
};
$('disconnect').onclick=function(){
  if(!confirm('Disconnect Spotify? Your saved sign-in will be removed from this PC.'))return;
  api('/api/disconnect',{}).then(function(){return load()}).then(function(){renderOverview();$('connect').hidden=false;$('connect').textContent='Connect Spotify';$('next3').hidden=true;$('connectState').textContent='';show(3)});
};
document.querySelectorAll('[data-next]').forEach(function(b){b.addEventListener('click',function(){if(step===4)return;if(step===1)renderOverview();show(Math.min(6,step+1));if(step===4)renderClients()})});
document.querySelectorAll('[data-back]').forEach(function(b){b.addEventListener('click',function(){show(Math.max(1,step-1));if(step===4)renderClients()})});
load().then(function(){renderOverview();renderSteps();if(data.auth.state==='connected'&&data.clients[0].registered)show(6)}).catch(function(e){say(e.message)});
})();
</script>
</body>
</html>`;
