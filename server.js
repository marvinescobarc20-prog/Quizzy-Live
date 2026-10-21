// Quizzy Live – servidor sin dependencias (solo módulos incluidos en Node.js)
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const PORT=+process.env.PORT||3000;
const questions=JSON.parse(fs.readFileSync(path.join(__dirname,'questions.json'),'utf8'));
const T=q=>q.time||20;
const HOST_KEY=process.env.HOST_KEY||'profe123';
let game;

function newGame(){
  if(game){clearTimeout(game.timer);for(const c of game.clients){send(c,{phase:'gone'});c.res.end()}}
  game={pin:String(100000+crypto.randomInt(900000)),phase:'lobby',qi:-1,startedAt:0,endsAt:0,
        players:new Map(),answers:new Map(),clients:new Set(),timer:null};
}
function board(){return [...game.players.values()].sort((a,b)=>b.score-a.score)}
function snap(role,id){
  const g=game,q=questions[g.qi],b=board();
  const s={phase:g.phase,pin:g.pin,qi:g.qi,total:questions.length,count:g.players.size,answered:g.answers.size,now:Date.now()};
  if(q&&(g.phase==='question'||g.phase==='reveal')){s.q={text:q.q,options:q.a};s.endsAt=g.endsAt;s.time=T(q)}
  if(g.phase==='reveal'){
    s.correct=q.c;
    s.counts=q.a.map((_,i)=>[...g.answers.values()].filter(a=>a.choice===i).length);
  }
  if(role==='host'){
    s.players=b.map(p=>p.name);
    s.top=b.slice(0,5).map(p=>({name:p.name,score:p.score}));
  }else{
    const p=g.players.get(id);
    if(!p)return {phase:'gone'};
    s.you={name:p.name,score:p.score,rank:b.indexOf(p)+1,answered:g.answers.has(id),last:p.last};
  }
  return s;
}
function send(c,obj){try{c.res.write('data: '+JSON.stringify(obj)+'\n\n')}catch(e){}}
function broadcast(){for(const c of game.clients)send(c,snap(c.role,c.id))}

function startQuestion(i){
  const g=game;g.qi=i;g.phase='question';g.answers=new Map();
  g.players.forEach(p=>p.last=null);
  g.startedAt=Date.now();g.endsAt=g.startedAt+T(questions[i])*1000;
  clearTimeout(g.timer);g.timer=setTimeout(reveal,T(questions[i])*1000+300);
  broadcast();
}
function reveal(){
  const g=game;if(g.phase!=='question')return;
  clearTimeout(g.timer);g.phase='reveal';
  const q=questions[g.qi],t=T(q);
  g.players.forEach((p,id)=>{
    const a=g.answers.get(id),ok=!!a&&a.choice===q.c;let gain=0;
    if(ok){
      const el=Math.min(t,Math.max(0,(a.t-g.startedAt)/1000));
      p.streak++;gain=Math.round(1000*(1-el/(2*t)))+Math.min(p.streak-1,5)*50;
    }else p.streak=0;
    p.score+=gain;p.last={choice:a?a.choice:-1,correct:ok,gain};
  });
  broadcast();
}
function next(){
  const g=game;if(g.phase!=='reveal')return;
  if(g.qi+1<questions.length)startQuestion(g.qi+1);else{g.phase='finished';broadcast()}
}

function addrs(){const r=[];for(const l of Object.values(os.networkInterfaces()))for(const i of l||[])r.push(i);return r}
function isHost(req,u){const k=req.headers['x-host-key']||u.searchParams.get('key')||'';return k===HOST_KEY}
function lanIps(){return addrs().filter(i=>(i.family==='IPv4'||i.family===4)&&!i.internal).map(i=>i.address)}
function body(req){return new Promise(r=>{let d='';req.on('data',c=>{d+=c;if(d.length>1e4)req.destroy()});req.on('end',()=>{try{r(JSON.parse(d||'{}'))}catch(e){r({})}})})}
function json(res,code,obj){res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(obj))}
function file(res,name){
  fs.readFile(path.join(__dirname,'public',name),(e,d)=>{
    if(e){res.writeHead(404);return res.end('No encontrado')}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(d);
  });
}
function events(req,res,u){
  const role=u.searchParams.get('role')==='host'?'host':'player',id=u.searchParams.get('id');
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});
  res.write('retry: 2000\n\n');
  const ok=role==='host'?isHost(req,u):(u.searchParams.get('pin')===game.pin&&game.players.has(id));
  if(!ok){send({res},{phase:'gone'});return res.end()}
  const c={res,role,id};game.clients.add(c);send(c,snap(role,id));
  const ka=setInterval(()=>{try{res.write(': ping\n\n')}catch(e){}},15000);
  req.on('close',()=>{clearInterval(ka);game.clients.delete(c)});
}

newGame();
http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://x'),p=u.pathname;
    if(req.method==='GET'){
      if(p==='/'){res.writeHead(302,{Location:'/play'});return res.end()}
      if(p==='/host')return file(res,'host.html');
      if(p==='/play')return file(res,'play.html');
      if(p==='/api/info')return json(res,200,{ips:lanIps()});
      if(p==='/events')return events(req,res,u);
      res.writeHead(404);return res.end('No encontrado');
    }
    if(req.method==='POST'){
      const b=await body(req);
      if(p==='/api/join'){
        if(String(b.pin)!==game.pin)return json(res,400,{error:'PIN incorrecto'});
        if(game.phase!=='lobby')return json(res,400,{error:'La partida ya empezó'});
        const name=String(b.name||'').trim().slice(0,20);
        if(!name)return json(res,400,{error:'Escribe tu nombre'});
        const used=[...game.players.values()].map(x=>x.name.toLowerCase());
        let n=name,k=2;while(used.includes(n.toLowerCase()))n=name+' '+k++;
        const id=crypto.randomBytes(6).toString('hex');
        game.players.set(id,{id,name:n,score:0,streak:0,last:null});
        broadcast();return json(res,200,{id,name:n});
      }
      if(p==='/api/answer'){
        const pl=game.players.get(b.id),ch=+b.choice;
        if(String(b.pin)!==game.pin||!pl)return json(res,400,{error:'Sesión inválida'});
        const q=questions[game.qi];
        if(game.phase!=='question'||Date.now()>game.endsAt+500||game.answers.has(b.id)||!(ch>=0&&ch<q.a.length))return json(res,200,{ok:false});
        game.answers.set(b.id,{choice:ch,t:Date.now()});
        if(game.answers.size>=game.players.size)reveal();else broadcast();
        return json(res,200,{ok:true});
      }
      if(p.startsWith('/api/host/')){
        if(!isHost(req,u))return json(res,403,{error:'Clave incorrecta'});
        const a=p.slice(10);
        if(a==='new'){newGame();return json(res,200,{pin:game.pin})}
        if(a==='start'&&game.phase==='lobby'&&game.players.size>0)startQuestion(0);
        if(a==='reveal')reveal();
        if(a==='next')next();
        return json(res,200,{ok:true});
      }
    }
    res.writeHead(404);res.end();
  }catch(e){console.error(e);try{res.writeHead(500);res.end()}catch(_){}}
})
.listen(PORT,'0.0.0.0',()=>{
  console.log('\nQuizzy Live listo en el puerto '+PORT+' ('+questions.length+' preguntas)');
  console.log('  Anfitrión:  /host   (clave: '+(process.env.HOST_KEY?'la de HOST_KEY':HOST_KEY)+')');
  console.log('  Jugadores:  /play\n');
});
