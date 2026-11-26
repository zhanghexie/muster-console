/** Host-owned picker overlay. The web page keeps its own content colors. */
export interface BrowserPickerAppearance {
  background: string; foreground: string; shadow: string; indicator: string; fill: string;
}
export function buildBrowserPickerScript(appearance: BrowserPickerAppearance): string {
  return `(function(appearance){
  if (window.__maPickActive) return Promise.resolve('busy');
  window.__maPickActive = true;
  var tip=document.createElement('div');
  tip.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;font:12px system-ui,sans-serif;padding:3px 8px;border-radius:6px;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  tip.style.background=appearance.background;tip.style.color=appearance.foreground;tip.style.boxShadow=appearance.shadow;
  var box=document.createElement('div');
  box.style.cssText='position:fixed;z-index:2147483646;pointer-events:none;border:2px solid';
  box.style.borderColor=appearance.indicator;box.style.background=appearance.fill;
  document.documentElement.appendChild(tip);document.documentElement.appendChild(box);
  function selOf(el){
    if(el.id)return el.tagName.toLowerCase()+'#'+el.id;
    var parts=[],n=el;
    while(n&&n.nodeType===1&&parts.length<4){
      var p=n.tagName.toLowerCase();
      if(n.id){parts.unshift(p+'#'+n.id);break;}
      var i=1,sib=n;
      while((sib=sib.previousElementSibling)){if(sib.tagName===n.tagName)i++;}
      parts.unshift(p+':nth-of-type('+i+')');n=n.parentElement;
    }
    return parts.join('>')||el.tagName.toLowerCase();
  }
  function nameOf(el){
    var a=el.getAttribute?el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('name')||'':'';
    return a||(el.textContent||'').replace(/\\s+/g, ' ').trim().slice(0,40);
  }
  var cur=null;
  function onOver(e){
    cur=e.target;var r=cur.getBoundingClientRect();
    box.style.display='block';box.style.left=r.left+'px';box.style.top=r.top+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';
    tip.style.display='block';tip.textContent=selOf(cur);
    tip.style.left=Math.max(4,r.left)+'px';tip.style.top=(r.top>28?r.top-26:4)+'px';
  }
  function cleanup(){
    window.__maPickActive=false;
    removeEventListener('mouseover',onOver,true);removeEventListener('mousedown',onDown,true);removeEventListener('keydown',onEsc,true);
    tip.remove();box.remove();
  }
  function onDown(e){
    e.preventDefault();e.stopPropagation();
    var el=cur||e.target;var r=el.getBoundingClientRect();
    var info={selector:selOf(el),tag:el.tagName.toLowerCase(),id:el.id||'',text:nameOf(el),url:location.href,
    rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}};
    cleanup();window.__maPickResolve(info);
  }
  function onEsc(e){if(e.key==='Escape'){cleanup();window.__maPickResolve(null);}}
  window.__maPickCancel=function(){if(window.__maPickActive){cleanup();window.__maPickResolve(null);}};
  addEventListener('mouseover',onOver,true);addEventListener('mousedown',onDown,true);addEventListener('keydown',onEsc,true);
  return new Promise(function(res){window.__maPickResolve=res;});
})(${JSON.stringify(appearance)})`;
}
