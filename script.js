(function(){
  const canvas = document.getElementById('labelCanvas');
  const ctx = canvas.getContext('2d');
  const workspace = document.getElementById('workspace');

  let objects = [];
  let selectedId = null;
  let nextId = 1;

  let canvasBg = {type:'solid', hex:'#ffffff'};
  let borderW = 0;
  let borderColorValue = {type:'solid', hex:'#1B2A28'};

  let unit = 'px';
  let dpi = 300;

  // ================= view zoom / pan =================
  const canvasWrap = document.getElementById('canvasWrap');
  const zoomLabel = document.getElementById('zoomLabel');
  const VIEW_ZOOM_MIN = 0.4, VIEW_ZOOM_MAX = 4;
  let viewZoom = 1;
  function setViewZoom(z){
    viewZoom = Math.max(VIEW_ZOOM_MIN, Math.min(VIEW_ZOOM_MAX, z));
    canvasWrap.style.transform = `scale(${viewZoom})`;
    zoomLabel.textContent = Math.round(viewZoom*100)+'%';
  }
  function resetViewZoom(){
    setViewZoom(1);
    workspace.scrollLeft = (workspace.scrollWidth-workspace.clientWidth)/2;
    workspace.scrollTop = (workspace.scrollHeight-workspace.clientHeight)/2;
  }
  document.getElementById('zoomIn').addEventListener('click', ()=> setViewZoom(viewZoom+0.2));
  document.getElementById('zoomOut').addEventListener('click', ()=> setViewZoom(viewZoom-0.2));
  document.getElementById('zoomReset').addEventListener('click', resetViewZoom);
  setViewZoom(1);

  // zoom con rueda/trackpad: Ctrl+rueda (o pellizco de trackpad) hace zoom; rueda normal desplaza
  workspace.addEventListener('wheel', e=>{
    if(e.ctrlKey || e.metaKey){
      e.preventDefault();
      setViewZoom(viewZoom - e.deltaY*0.01);
    }
  }, {passive:false});

  const FONTS = ['Inter','Poppins','Fredoka','Caveat','Bangers','Georgia','Arial','Courier New'];

  let guide = {x:null, y:null};

  // ================= portapapeles / historial (deshacer-rehacer) =================
  function cloneObjectData(o){
    const plain = Object.assign({}, o);
    if(o.type==='image') plain.img = undefined;
    const cloned = JSON.parse(JSON.stringify(plain));
    if(o.type==='image') cloned.img = o.img;
    return cloned;
  }
  let objectClipboard = null;
  let history = [];
  let future = [];
  const HISTORY_LIMIT = 5;
  let pendingSnapshot = null;
  function snapshotState(){
    return { objects: objects.map(o=>cloneObjectData(o)), canvasWidth: canvas.width, canvasHeight: canvas.height };
  }
  function pushHistory(){
    history.push(snapshotState());
    if(history.length>HISTORY_LIMIT) history.shift();
    future = [];
    updateUndoRedoButtons();
  }
  function applyState(state){
    objects = state.objects.map(o=>cloneObjectData(o));
    canvas.width = state.canvasWidth; canvas.height = state.canvasHeight;
    selectedId = null; closePopover(); hideFloatBar();
    render();
    updateUndoRedoButtons();
  }
  function undo(){
    if(history.length===0) return;
    future.push(snapshotState());
    if(future.length>HISTORY_LIMIT) future.shift();
    applyState(history.pop());
  }
  function redo(){
    if(future.length===0) return;
    history.push(snapshotState());
    if(history.length>HISTORY_LIMIT) history.shift();
    applyState(future.pop());
  }
  function updateUndoRedoButtons(){
    const u=document.getElementById('btnUndo'), r=document.getElementById('btnRedo');
    if(u) u.disabled = history.length===0;
    if(r) r.disabled = future.length===0;
  }
  function copySelectedObject(){
    const o = objects.find(x=>x.id===selectedId);
    if(!o) return;
    objectClipboard = cloneObjectData(o);
  }
  function cutSelectedObject(){
    const o = objects.find(x=>x.id===selectedId);
    if(!o) return;
    pushHistory();
    objectClipboard = cloneObjectData(o);
    objects = objects.filter(x=>x.id!==selectedId);
    selectedId = null;
    closePopover(); hideFloatBar(); render();
  }
  function pasteObject(){
    if(!objectClipboard) return;
    pushHistory();
    const copy = cloneObjectData(objectClipboard);
    copy.id = nextId++;
    copy.x = (copy.x||0) + 18;
    copy.y = (copy.y||0) + 18;
    objects.push(copy);
    selectedId = copy.id;
    render();
  }

  // ================= variables y lotes =================
  let dataLists = [];
  let nextListId = 1;
  let nextGroupId = 1;
  let showNewListForm = false;
  let batchPreviewActive = false;
  let previewOriginals = null;
  let previewRows = [];
  let previewIndex = 0;

  function detectVariables(){
    const set = new Set();
    objects.forEach(o=>{
      if(o.type==='text'){
        const matches = o.content.match(/@([A-Za-zÀ-ÖØ-öø-ÿ0-9_]+)/g) || [];
        matches.forEach(m=> set.add(m.slice(1)));
      }
    });
    return Array.from(set);
  }
  // sustituye variables Y reubica el formato (negrita/cursiva/subrayado/tachado) que caía sobre ellas,
  // para que si seleccionaste exactamente "@Variable" el formato cubra todo el valor sustituido, sea cual sea su longitud.
  function substituteWithRanges(content, richRanges, dataRow){
    const tokenRegex = /@([A-Za-zÀ-ÖØ-öø-ÿ0-9_]+)/g;
    const tokens = [];
    let m;
    while((m = tokenRegex.exec(content))){
      tokens.push({ name:m[1], start:m.index, end:m.index+m[0].length });
    }
    let output='', cursor=0;
    const tokenNewSpans = [];
    tokens.forEach(tok=>{
      output += content.slice(cursor, tok.start);
      const value = Object.prototype.hasOwnProperty.call(dataRow, tok.name) ? String(dataRow[tok.name]) : content.slice(tok.start, tok.end);
      const newStart = output.length;
      output += value;
      tokenNewSpans.push({ start:newStart, end:output.length });
      cursor = tok.end;
    });
    output += content.slice(cursor);

    const newRanges = (richRanges||[]).map(r=>{
      const tokIdx = tokens.findIndex(t=> t.start===r.start && t.end===r.end);
      if(tokIdx>=0){
        const span = tokenNewSpans[tokIdx];
        return Object.assign({}, r, { start:span.start, end:span.end });
      }
      // sin coincidencia exacta con una variable: desplaza el rango según cuánto cambió el largo antes de él
      let shift = 0;
      tokens.forEach((t,i)=>{ if(t.end<=r.start) shift += (tokenNewSpans[i].end-tokenNewSpans[i].start) - (t.end-t.start); });
      return Object.assign({}, r, { start:Math.max(0,r.start+shift), end:Math.max(0,r.end+shift) });
    });
    return { content: output, richRanges: newRanges };
  }
  function getSelectedLists(){
    const ids = Array.from(document.querySelectorAll('.combineChk:checked')).map(c=>parseInt(c.dataset.id));
    return dataLists.filter(l=> ids.includes(l.id) && listRowCount(l)>0);
  }
  function cartesianOf(rowArrays){
    return rowArrays.reduce((acc, rows)=>{
      const out=[];
      acc.forEach(prefix=> rows.forEach(row=> out.push(Object.assign({}, prefix, row))));
      return out;
    }, [{}]);
  }
  function effectiveRows(list){
    const groupsWithRows = list.groups.filter(g=> g.rows.length>0);
    if(groupsWithRows.length===0) return [];
    return cartesianOf(groupsWithRows.map(g=>g.rows));
  }
  function listRowCount(list){ return effectiveRows(list).length; }
  function cartesianRows(lists){ return cartesianOf(lists.map(l=> effectiveRows(l))); }
  function sanitizeFilename(s){
    return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_-]+/g,'_').replace(/^_+|_+$/g,'') || 'etiqueta';
  }
  function filenameForRow(dataRow, index){
    const parts = [];
    ['Alumno','Materia'].forEach(k=>{ if(dataRow[k]!=null && dataRow[k]!=='') parts.push(dataRow[k]); });
    if(parts.length===0){
      Object.keys(dataRow).slice(0,2).forEach(k=>{ if(dataRow[k]!=null && dataRow[k]!=='') parts.push(dataRow[k]); });
    }
    return parts.length ? parts.map(sanitizeFilename).join('_') : `etiqueta_${String(index+1).padStart(3,'0')}`;
  }
  function applyPreviewRow(dataRow){
    if(!batchPreviewActive){
      previewOriginals = new Map();
      objects.forEach(o=>{ if(o.type==='text') previewOriginals.set(o.id, { content:o.content, richRanges:(o.richRanges||[]).map(r=>Object.assign({},r)) }); });
    }
    objects.forEach(o=>{
      if(o.type==='text'){
        const base = previewOriginals.has(o.id) ? previewOriginals.get(o.id) : { content:o.content, richRanges:o.richRanges };
        const result = substituteWithRanges(base.content, base.richRanges, dataRow);
        o.content = result.content;
        o.richRanges = result.richRanges;
      }
    });
    batchPreviewActive = true;
    render();
  }
  function restoreBatchPreview(){
    if(!batchPreviewActive || !previewOriginals) return;
    objects.forEach(o=>{
      if(o.type==='text' && previewOriginals.has(o.id)){
        const base = previewOriginals.get(o.id);
        o.content = base.content; o.richRanges = base.richRanges;
      }
    });
    batchPreviewActive = false; previewOriginals = null;
    render();
  }

  // ================= color helpers =================
  function clamp255(x){ x=parseInt(x); if(isNaN(x)) x=0; return Math.max(0,Math.min(255,x)); }
  function hexToRgb(hex){
    hex=(hex||'#000000').replace('#','');
    if(hex.length===3) hex=hex.split('').map(c=>c+c).join('');
    const num=parseInt(hex,16)||0;
    return {r:(num>>16)&255, g:(num>>8)&255, b:num&255};
  }
  function rgbToHex(r,g,b){ return '#'+[r,g,b].map(v=>clamp255(v).toString(16).padStart(2,'0')).join(''); }

  function styleFor(ctxRef, value, x,y,w,h){
    if(!value) return '#000000';
    if(value.type==='solid') return value.hex;
    const rad = (value.angle||0)*Math.PI/180;
    const dirX=Math.cos(rad), dirY=Math.sin(rad);
    const diag = Math.sqrt(w*w+h*h)/2 || 1;
    const cx=x+w/2, cy=y+h/2;
    const grad = ctxRef.createLinearGradient(cx-dirX*diag, cy-dirY*diag, cx+dirX*diag, cy+dirY*diag);
    const stops = [...value.stops].sort((a,b)=>a.pos-b.pos);
    stops.forEach(s=> grad.addColorStop(Math.max(0,Math.min(100,s.pos))/100, s.hex));
    return grad;
  }

  function initColorControl(container, initialValue, onChange){
    let value = JSON.parse(JSON.stringify(initialValue));
    function html(v){
      let out = `<div class="ccModes">
        <button type="button" class="cc-mode ${v.type==='solid'?'toggled':''}" data-m="solid">Sólido</button>
        <button type="button" class="cc-mode ${v.type==='gradient'?'toggled':''}" data-m="gradient">Degradado</button>
      </div>`;
      if(v.type==='solid'){
        const rgb = hexToRgb(v.hex);
        out += `
          <div class="row">
            <input type="color" class="cc-swatch" value="${v.hex}">
            <input type="text" class="cc-hex" value="${v.hex}">
          </div>
          <div class="row" style="margin-top:6px">
            <label class="field">R<input type="number" class="cc-r" min="0" max="255" value="${rgb.r}"></label>
            <label class="field">G<input type="number" class="cc-g" min="0" max="255" value="${rgb.g}"></label>
            <label class="field">B<input type="number" class="cc-b" min="0" max="255" value="${rgb.b}"></label>
          </div>`;
      } else {
        v.stops.forEach((s,i)=>{
          out += `<div class="row ccStopRow" data-i="${i}">
            <input type="color" class="cc-stopcolor" value="${s.hex}">
            <input type="number" class="cc-stoppos" min="0" max="100" value="${s.pos}">
            <button type="button" class="cc-stopdel" ${v.stops.length<=2?'disabled':''}>✕</button>
          </div>`;
        });
        out += `<button type="button" class="cc-addstop block" ${v.stops.length>=3?'disabled':''} style="margin-top:6px">+ Color</button>
          <label class="field" style="margin-top:9px">Ángulo: <span class="cc-angleval">${v.angle}</span>°
            <input type="range" class="cc-angle" min="0" max="360" value="${v.angle}">
          </label>`;
      }
      return out;
    }
    function paint(){ container.innerHTML = html(value); wire(); }
    function wire(){
      container.querySelectorAll('.cc-mode').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          const m = btn.dataset.m;
          if(m===value.type) return;
          if(m==='gradient'){
            value = {type:'gradient', angle:90, stops:[{hex:value.hex||'#F2C14E',pos:0},{hex:'#4FBDBA',pos:100}]};
          } else {
            value = {type:'solid', hex:(value.stops && value.stops[0] && value.stops[0].hex) || '#F2C14E'};
          }
          onChange(value); paint();
        });
      });
      if(value.type==='solid'){
        const swatch=container.querySelector('.cc-swatch'), hexI=container.querySelector('.cc-hex');
        const rI=container.querySelector('.cc-r'), gI=container.querySelector('.cc-g'), bI=container.querySelector('.cc-b');
        swatch.addEventListener('input', ()=>{
          value.hex=swatch.value; hexI.value=swatch.value;
          const rgb=hexToRgb(swatch.value); rI.value=rgb.r; gI.value=rgb.g; bI.value=rgb.b;
          onChange(value);
        });
        hexI.addEventListener('change', ()=>{
          let h=hexI.value.trim(); if(!h.startsWith('#')) h='#'+h;
          if(/^#[0-9a-fA-F]{6}$/.test(h)){ value.hex=h; swatch.value=h; const rgb=hexToRgb(h); rI.value=rgb.r; gI.value=rgb.g; bI.value=rgb.b; onChange(value); }
        });
        [rI,gI,bI].forEach(inp=> inp.addEventListener('input', ()=>{
          const hex = rgbToHex(rI.value,gI.value,bI.value);
          value.hex=hex; swatch.value=hex; hexI.value=hex; onChange(value);
        }));
      } else {
        container.querySelectorAll('.ccStopRow').forEach(row=>{
          const i = parseInt(row.dataset.i);
          row.querySelector('.cc-stopcolor').addEventListener('input', e=>{ value.stops[i].hex=e.target.value; onChange(value); });
          row.querySelector('.cc-stoppos').addEventListener('input', e=>{ value.stops[i].pos=parseInt(e.target.value)||0; onChange(value); });
          const del = row.querySelector('.cc-stopdel');
          del.addEventListener('click', ()=>{ if(value.stops.length>2){ value.stops.splice(i,1); onChange(value); paint(); } });
        });
        const addBtn = container.querySelector('.cc-addstop');
        if(addBtn) addBtn.addEventListener('click', ()=>{
          if(value.stops.length<3){ value.stops.push({hex:'#E8623D', pos:50}); onChange(value); paint(); }
        });
        const angleI = container.querySelector('.cc-angle');
        if(angleI) angleI.addEventListener('input', e=>{
          value.angle=parseInt(e.target.value);
          container.querySelector('.cc-angleval').textContent = value.angle;
          onChange(value);
        });
      }
    }
    paint();
  }

  // ================= dropdown menus =================
  function positionDropdownPanel(btn, panel){
    const btnRect = btn.getBoundingClientRect();
    const margin = 8;
    if(!panel.dataset.naturalWidth){
      panel.dataset.naturalWidth = panel.offsetWidth || 270;
    }
    const naturalWidth = parseFloat(panel.dataset.naturalWidth) || 270;
    const pw = Math.min(naturalWidth, window.innerWidth - margin*2);
    panel.style.width = pw + 'px';
    const ph = Math.min(panel.scrollHeight, window.innerHeight - margin*2);
    let left = Math.min(Math.max(btnRect.left, margin), window.innerWidth - pw - margin);
    let top = btnRect.bottom + 6;
    if(top + ph > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - ph - margin);
    panel.style.position = 'fixed';
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
  }
  function setupDropdown(btnId, panelId){
    const btn = document.getElementById(btnId), panel = document.getElementById(panelId);
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      const wasOpen = panel.classList.contains('open');
      closeAllDropdowns();
      if(!wasOpen){ panel.classList.add('open'); positionDropdownPanel(btn, panel); }
    });
    panel.addEventListener('click', e=> e.stopPropagation());
  }
  window.addEventListener('resize', ()=>{
    const openPanel = document.querySelector('.dropdown-panel.open');
    if(openPanel){
      const btn = openPanel.previousElementSibling;
      if(btn) positionDropdownPanel(btn, openPanel);
    }
  });
  function closeAllDropdowns(){ document.querySelectorAll('.dropdown-panel').forEach(p=>p.classList.remove('open')); }
  setupDropdown('btnDdCanvas','panelCanvas');
  setupDropdown('btnDdInsert','panelInsert');
  document.getElementById('btnDdBatch').addEventListener('click', renderBatchPanel);
  setupDropdown('btnDdBatch','panelBatch');

  // ================= panel de listas / lote =================
  let showNewGroupForListId = null;

  function renderBatchPanel(){
    const vars = detectVariables();
    const varsEl = document.getElementById('varsDetected');
    varsEl.innerHTML = vars.length
      ? vars.map(v=>`<span class="varChip">@${escapeHtml(v)}</span>`).join('')
      : 'Escribe @NombreVariable en un texto del diseño (ej: @Alumno) y aparecerá aquí.';

    const listsContainer = document.getElementById('dataListsContainer');
    let html = dataLists.map(list=>{
      const groupsHtml = list.groups.map(g=>`
        <div class="dgroup" data-group="${g.id}" data-list="${list.id}">
          <div class="dgroupHead">
            <span class="dgroupCols">${g.columns.map(c=>'@'+escapeHtml(c)).join(' + ')}</span>
            <button type="button" class="danger small dgroupDel" data-list="${list.id}" data-group="${g.id}">✕ grupo</button>
          </div>
          <div class="dlistTableWrap"><table class="dlistTable">
            <thead><tr>${g.columns.map(c=>`<th>${escapeHtml(c)}</th>`).join('')}<th></th></tr></thead>
            <tbody>
              ${g.rows.map((row,ri)=>`
                <tr>
                  ${g.columns.map(c=>`<td><input type="text" class="dlistCell" data-list="${list.id}" data-group="${g.id}" data-ri="${ri}" data-col="${escapeHtml(c)}" value="${escapeHtml(row[c]||'')}"></td>`).join('')}
                  <td><button type="button" class="danger small dlistRowDel" data-list="${list.id}" data-group="${g.id}" data-ri="${ri}">✕</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table></div>
          <div class="row" style="gap:6px">
            <button type="button" class="small dlistAddRow" data-list="${list.id}" data-group="${g.id}" style="flex:1">+ Fila</button>
          </div>
          <details class="dlistCsvBox" style="margin-top:6px">
            <summary>Pegar tabla (CSV)</summary>
            <p class="hint">Primera línea = encabezado (se ignora). Luego una fila por línea, valores separados por comas, en este orden: ${g.columns.join(', ')}</p>
            <textarea class="dlistCsv" data-list="${list.id}" data-group="${g.id}" placeholder="${g.columns.join(',')}\n${g.columns.map(()=>'valor').join(',')}"></textarea>
            <button type="button" class="small block dlistImport" data-list="${list.id}" data-group="${g.id}" style="margin-top:4px">Importar tabla</button>
          </details>
        </div>
      `).join('');
      const rowCount = listRowCount(list);
      return `
        <div class="dlist" data-list="${list.id}">
          <div class="dlistHead">
            <input type="text" class="dlistName" data-id="${list.id}" value="${escapeHtml(list.name)}">
            <button type="button" class="danger small dlistDel" data-id="${list.id}">✕ lista</button>
          </div>
          ${groupsHtml || '<p class="hint">Esta lista no tiene columnas todavía. Agrega un grupo (ej: Alumno, o Maestro+Materia).</p>'}
          ${showNewGroupForListId===list.id ? newGroupFormHtml(list, vars) : `<button type="button" class="small block dgroupNew" data-list="${list.id}" style="margin-top:4px">+ Nuevo grupo de columnas</button>`}
          <p class="hint" style="margin-top:6px">${list.groups.length>1 ? `Esta lista cruza sus grupos: generará ${rowCount} fila${rowCount===1?'':'s'}.` : ''}</p>
        </div>
      `;
    }).join('');
    if(showNewListForm){
      html += `
        <div class="dlist" style="border-color:var(--teal)">
          <label class="field">Nombre de la lista<input type="text" id="newListName" placeholder="Ej: Etiqueta general"></label>
          <div class="row" style="margin-top:8px">
            <button type="button" class="accent" id="btnCreateList" style="flex:1">Crear</button>
            <button type="button" class="small" id="btnCancelNewList" style="flex:1">Cancelar</button>
          </div>
        </div>
      `;
    }
    listsContainer.innerHTML = html || (showNewListForm ? '' : '<p class="hint">No hay listas todavía.</p>');
    wireListEvents(vars);

    const combineContainer = document.getElementById('batchCombineContainer');
    if(dataLists.length===0){
      combineContainer.innerHTML = '<p class="hint">Crea al menos una lista para generar etiquetas.</p>';
      document.getElementById('batchPreviewCount').textContent='';
      document.getElementById('btnBatchExport').disabled = true;
    } else {
      combineContainer.innerHTML = dataLists.map(l=>`
        <div class="row" style="margin-bottom:6px;align-items:center">
          <input type="checkbox" class="combineChk" data-id="${l.id}" checked style="width:auto;flex:none;min-height:auto">
          <span style="flex:1;font-size:12px">${escapeHtml(l.name)} (${listRowCount(l)} filas)</span>
        </div>
      `).join('');
      combineContainer.querySelectorAll('.combineChk').forEach(chk=> chk.addEventListener('change', updateBatchPreviewCount));
      updateBatchPreviewCount();
    }
  }

  function newGroupFormHtml(list, vars){
    return `
      <div class="dgroup" style="border-color:var(--teal)">
        <p class="hint">Elige qué variable(s) van juntas en este grupo (ej: solo Alumno, o Maestro + Materia):</p>
        ${vars.length ? vars.map(v=>`<label class="colChk"><input type="checkbox" class="newGroupVar" value="${escapeHtml(v)}"> @${escapeHtml(v)}</label>`).join('') : '<p class="hint">No hay variables detectadas todavía.</p>'}
        <div class="row" style="margin-top:8px">
          <button type="button" class="accent" id="btnCreateGroup" data-list="${list.id}" style="flex:1">Crear grupo</button>
          <button type="button" class="small" id="btnCancelNewGroup" style="flex:1">Cancelar</button>
        </div>
      </div>
    `;
  }

  function wireListEvents(vars){
    const listsContainer = document.getElementById('dataListsContainer');
    listsContainer.querySelectorAll('.dlistName').forEach(inp=> inp.addEventListener('change', e=>{
      const list = dataLists.find(l=>l.id===parseInt(e.target.dataset.id));
      if(list){ list.name = e.target.value.trim() || list.name; renderBatchPanel(); }
    }));
    listsContainer.querySelectorAll('.dlistDel').forEach(btn=> btn.addEventListener('click', e=>{
      if(!confirm('¿Eliminar esta lista y todos sus datos?')) return;
      dataLists = dataLists.filter(l=>l.id!==parseInt(e.target.dataset.id));
      renderBatchPanel();
    }));
    listsContainer.querySelectorAll('.dgroupDel').forEach(btn=> btn.addEventListener('click', e=>{
      const list = dataLists.find(l=>l.id===parseInt(e.target.dataset.list));
      if(!list) return;
      if(!confirm('¿Eliminar este grupo de columnas y sus filas?')) return;
      list.groups = list.groups.filter(g=>g.id!==parseInt(e.target.dataset.group));
      renderBatchPanel();
    }));
    listsContainer.querySelectorAll('.dlistCell').forEach(inp=> inp.addEventListener('input', e=>{
      const list = dataLists.find(l=>l.id===parseInt(e.target.dataset.list));
      const group = list && list.groups.find(g=>g.id===parseInt(e.target.dataset.group));
      if(group) group.rows[parseInt(e.target.dataset.ri)][e.target.dataset.col] = e.target.value;
    }));
    listsContainer.querySelectorAll('.dlistRowDel').forEach(btn=> btn.addEventListener('click', e=>{
      const list = dataLists.find(l=>l.id===parseInt(e.target.dataset.list));
      const group = list && list.groups.find(g=>g.id===parseInt(e.target.dataset.group));
      if(group){ group.rows.splice(parseInt(e.target.dataset.ri),1); renderBatchPanel(); }
    }));
    listsContainer.querySelectorAll('.dlistAddRow').forEach(btn=> btn.addEventListener('click', e=>{
      const list = dataLists.find(l=>l.id===parseInt(e.target.dataset.list));
      const group = list && list.groups.find(g=>g.id===parseInt(e.target.dataset.group));
      if(group){ const row={}; group.columns.forEach(c=>row[c]=''); group.rows.push(row); renderBatchPanel(); }
    }));
    listsContainer.querySelectorAll('.dlistImport').forEach(btn=> btn.addEventListener('click', e=>{
      const list = dataLists.find(l=>l.id===parseInt(e.target.dataset.list));
      const group = list && list.groups.find(g=>g.id===parseInt(e.target.dataset.group));
      const ta = listsContainer.querySelector(`.dlistCsv[data-list="${e.target.dataset.list}"][data-group="${e.target.dataset.group}"]`);
      if(!group || !ta || !ta.value.trim()) return;
      const lines = ta.value.split(/\r\n|\r|\n/).filter(l=>l.trim()!=='');
      lines.slice(1).forEach(line=>{
        const valsArr = line.split(',').map(v=>v.trim());
        const row = {};
        group.columns.forEach((c,i)=> row[c]=valsArr[i]||'');
        group.rows.push(row);
      });
      renderBatchPanel();
    }));
    listsContainer.querySelectorAll('.dgroupNew').forEach(btn=> btn.addEventListener('click', e=>{
      showNewGroupForListId = parseInt(e.target.dataset.list);
      renderBatchPanel();
    }));
    if(document.getElementById('btnCreateGroup')){
      document.getElementById('btnCreateGroup').addEventListener('click', e=>{
        const list = dataLists.find(l=>l.id===parseInt(e.target.dataset.list));
        const cols = Array.from(document.querySelectorAll('.newGroupVar:checked')).map(c=>c.value);
        if(!list || cols.length===0){ alert('Elige al menos una variable para el grupo.'); return; }
        list.groups.push({ id: nextGroupId++, columns: cols, rows: [] });
        showNewGroupForListId = null;
        renderBatchPanel();
      });
      document.getElementById('btnCancelNewGroup').addEventListener('click', ()=>{ showNewGroupForListId=null; renderBatchPanel(); });
    }
    if(showNewListForm){
      document.getElementById('btnCreateList').addEventListener('click', ()=>{
        const name = document.getElementById('newListName').value.trim() || `Lista ${nextListId}`;
        dataLists.push({id: nextListId++, name, groups: []});
        showNewListForm = false;
        renderBatchPanel();
      });
      document.getElementById('btnCancelNewList').addEventListener('click', ()=>{ showNewListForm=false; renderBatchPanel(); });
    }
  }

  function updateBatchPreviewCount(){
    const sel = getSelectedLists();
    const count = sel.length ? sel.reduce((p,l)=> p*listRowCount(l), 1) : 0;
    document.getElementById('batchPreviewCount').textContent = count>0 ? `Se generarán ${count} etiqueta${count===1?'':'s'}.` : 'Selecciona al menos una lista con filas.';
    document.getElementById('btnBatchExport').disabled = count===0;
  }
  document.getElementById('btnNewList').addEventListener('click', ()=>{ showNewListForm=true; renderBatchPanel(); });

  const previewBar = document.getElementById('previewBar');
  const previewIndexLabel = document.getElementById('previewIndexLabel');
  function updatePreviewLabel(){
    previewIndexLabel.textContent = previewRows.length ? `${previewIndex+1} / ${previewRows.length}` : '';
  }
  function goToPreview(i){
    if(previewRows.length===0) return;
    previewIndex = ((i % previewRows.length) + previewRows.length) % previewRows.length;
    applyPreviewRow(previewRows[previewIndex]);
    updatePreviewLabel();
  }
  document.getElementById('btnBatchPreview').addEventListener('click', ()=>{
    const sel = getSelectedLists();
    if(sel.length===0){ alert('Marca al menos una lista con filas en "Generar etiquetas".'); return; }
    previewRows = cartesianRows(sel);
    if(previewRows.length===0) return;
    previewIndex = 0;
    applyPreviewRow(previewRows[previewIndex]);
    updatePreviewLabel();
    previewBar.style.display = 'flex';
    closeAllDropdowns();
  });
  document.getElementById('prevPreviewBtn').addEventListener('click', ()=> goToPreview(previewIndex-1));
  document.getElementById('nextPreviewBtn').addEventListener('click', ()=> goToPreview(previewIndex+1));
  document.getElementById('exitPreviewBtn').addEventListener('click', ()=>{
    restoreBatchPreview();
    previewBar.style.display = 'none';
    previewRows = []; previewIndex = 0;
  });
  document.getElementById('btnBatchExport').addEventListener('click', exportBatchZip);

  async function exportBatchZip(){
    const sel = getSelectedLists();
    if(sel.length===0) return;
    const rows = cartesianRows(sel);
    if(rows.length===0){ alert('No hay filas para generar.'); return; }
    if(typeof JSZip==='undefined'){ alert('No se pudo cargar la librería para crear el ZIP. Revisa tu conexión a internet e inténtalo de nuevo.'); return; }

    // si quedó una vista previa activa (con texto ya sustituido), restaurar la plantilla original
    // ANTES de capturar "originals" — si no, se exportaría el mismo texto sustituido repetido en todo el lote.
    if(batchPreviewActive) restoreBatchPreview();
    previewBar.style.display='none'; previewRows=[]; previewIndex=0;

    const btn = document.getElementById('btnBatchExport');
    const origLabel = btn.textContent;
    btn.disabled = true;

    const prevSel = selectedId; selectedId=null; guide={x:null,y:null};
    const originals = new Map();
    objects.forEach(o=>{ if(o.type==='text') originals.set(o.id, { content:o.content, richRanges:(o.richRanges||[]).map(r=>Object.assign({},r)) }); });

    const zip = new JSZip();
    const usedNames = new Set();
    for(let i=0;i<rows.length;i++){
      btn.textContent = `Generando ${i+1}/${rows.length}…`;
      const dataRow = rows[i];
      objects.forEach(o=>{
        if(o.type==='text'){
          const base = originals.get(o.id);
          const result = substituteWithRanges(base.content, base.richRanges, dataRow);
          o.content = result.content; o.richRanges = result.richRanges;
        }
      });
      render();
      await new Promise(r=>setTimeout(r,0));
      const blob = await new Promise(res=> canvas.toBlob(res, 'image/png'));
      let name = filenameForRow(dataRow, i), finalName = name, n=2;
      while(usedNames.has(finalName)){ finalName = `${name}_${n++}`; }
      usedNames.add(finalName);
      zip.file(`${finalName}.png`, blob);
    }
    objects.forEach(o=>{
      if(o.type==='text' && originals.has(o.id)){
        const base = originals.get(o.id);
        o.content = base.content; o.richRanges = base.richRanges;
      }
    });
    selectedId = prevSel; batchPreviewActive=false; previewOriginals=null; render();
    previewBar.style.display='none'; previewRows=[]; previewIndex=0;

    btn.textContent = 'Empaquetando ZIP…';
    const content = await zip.generateAsync({type:'blob'});
    const link = document.createElement('a');
    link.download = 'etiquetas.zip';
    link.href = URL.createObjectURL(content);
    link.click();
    setTimeout(()=> URL.revokeObjectURL(link.href), 4000);

    btn.textContent = origLabel;
    btn.disabled = false;
    updateBatchPreviewCount();
  }

  document.addEventListener('click', e=>{
    closeAllDropdowns();
    if(!popover.contains(e.target) && e.target!==canvas){ closePopover(); }
  });

  initColorControl(document.getElementById('canvasBgCtl'), canvasBg, v=>{ canvasBg=v; render(); });
  initColorControl(document.getElementById('borderColorCtl'), borderColorValue, v=>{ borderColorValue=v; render(); });

  // ================= unit conversion =================
  function toPx(value, u, d){
    if(u === 'px') return Math.round(value);
    if(u === 'in') return Math.round(value * d);
    if(u === 'cm') return Math.round((value/2.54) * d);
    return Math.round(value);
  }
  function updatePxPreview(){
    const w = parseFloat(document.getElementById('sizeW').value)||0;
    const h = parseFloat(document.getElementById('sizeH').value)||0;
    if(unit==='px'){ document.getElementById('pxPreview').textContent=''; return; }
    document.getElementById('pxPreview').textContent = `≈ ${toPx(w,unit,dpi)} × ${toPx(h,unit,dpi)} px a ${dpi} DPI`;
  }
  document.querySelectorAll('.unitgrp button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.unitgrp button').forEach(b=>b.classList.remove('toggled'));
      btn.classList.add('toggled');
      unit = btn.dataset.unit;
      document.getElementById('dpiField').style.display = (unit==='px') ? 'none':'flex';
      updatePxPreview();
    });
  });
  document.getElementById('sizeW').addEventListener('input', updatePxPreview);
  document.getElementById('sizeH').addEventListener('input', updatePxPreview);
  document.getElementById('dpi').addEventListener('input', ()=>{ dpi=parseInt(document.getElementById('dpi').value)||300; updatePxPreview(); });

  document.getElementById('btnApplySize').addEventListener('click', ()=>{
    const w = parseFloat(document.getElementById('sizeW').value)||0;
    const h = parseFloat(document.getElementById('sizeH').value)||0;
    const pw = toPx(w,unit,dpi), ph = toPx(h,unit,dpi);
    if(pw<10 || ph<10){ alert('El tamaño es demasiado pequeño.'); return; }
    pushHistory();
    canvas.width=pw; canvas.height=ph;
    render(); closeAllDropdowns();
  });
  document.getElementById('btnAutoSizeAll').addEventListener('click', ()=>{
    const texts = objects.filter(o=>o.type==='text');
    if(texts.length===0) return;
    pushHistory();
    texts.forEach(o=>{ o.autoSize = true; });
    render();
    closeAllDropdowns();
  });
  document.getElementById('borderW').addEventListener('input', e=>{ borderW=parseInt(e.target.value)||0; render(); });

  // ================= object factories =================
  function addText(){
    pushHistory();
    const obj = {
      id: nextId++, type:'text',
      x: canvas.width*0.2, y: canvas.height*0.35,
      w: Math.min(220, canvas.width*0.6), h: 60,
      content:'Nombre del alumno',
      richRanges: [],
      autoSize: true,
      fontFamily:'Poppins', fontSize:28,
      color:{type:'solid',hex:'#1B2A28'},
      bold:true, italic:false, align:'center', opacity:100,
      rotation:0, textShape:'recta', curveAmount:40,
      bgShape:'none', bgColor:{type:'solid',hex:'#F2C14E'},
      borderColor:{type:'solid',hex:'#1B2A28'}, borderWidth:0,
      strokeEnabled:false, strokeColor:{type:'solid',hex:'#000000'}, strokeWidth:3,
      shadowEnabled:false, shadowColor:'#000000', shadowBlur:10, shadowOffsetX:3, shadowOffsetY:3
    };
    objects.push(obj); selectedId=obj.id;
    render(); closeAllDropdowns();
  }
  function addImageObj(img, naturalW, naturalH){
    pushHistory();
    const maxW = canvas.width*0.5;
    let w=naturalW, h=naturalH;
    if(w>maxW){ const s=maxW/w; w*=s; h*=s; }
    const obj = {
      id:nextId++, type:'image', x:canvas.width*0.25, y:canvas.height*0.25, w, h, rotation:0,
      img, naturalW, naturalH, opacity:100,
      brightness:100, contrast:100, saturate:100, grayscale:0, sepia:0, blur:0,
      flipH:false, flipV:false, cornerShape:'none'
    };
    objects.push(obj); selectedId=obj.id;
    render();
  }
  function loadImageFile(file){
    const reader = new FileReader();
    reader.onload = ev=>{
      const img = new Image();
      img.onload = ()=> addImageObj(img, img.naturalWidth, img.naturalHeight);
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  document.getElementById('btnAddText').addEventListener('click', addText);
  document.getElementById('fileInput').addEventListener('change', e=>{
    [...e.target.files].forEach(loadImageFile);
    e.target.value = '';
    closeAllDropdowns();
  });

  ['dragenter','dragover'].forEach(evt=>{
    workspace.addEventListener(evt, e=>{ e.preventDefault(); workspace.classList.add('dragover'); });
  });
  ['dragleave','drop'].forEach(evt=>{
    workspace.addEventListener(evt, e=>{
      if(evt==='dragleave' && e.target!==workspace) return;
      workspace.classList.remove('dragover');
    });
  });
  workspace.addEventListener('drop', e=>{
    e.preventDefault();
    const dt = e.dataTransfer;
    if(dt.files && dt.files.length){
      [...dt.files].forEach(f=>{ if(f.type.startsWith('image/')) loadImageFile(f); });
      return;
    }
    const uri = dt.getData('text/uri-list') || dt.getData('text/plain');
    if(uri && /^https?:\/\//i.test(uri)){
      fetch(uri).then(r=>r.blob()).then(blob=>{
        if(!blob.type.startsWith('image/')) throw new Error('not image');
        loadImageFile(blob);
      }).catch(()=>{
        alert('No se pudo traer esa imagen directamente (restricción del sitio de origen). Guárdala en tu equipo y usa "Insertar → Imagen".');
      });
    }
  });
  window.addEventListener('paste', e=>{
    const items = e.clipboardData && e.clipboardData.items;
    if(!items) return;
    for(const item of items){
      if(item.type.startsWith('image/')) loadImageFile(item.getAsFile());
    }
  });

  document.getElementById('btnDelete').addEventListener('click', deleteSelected);
  function deleteSelected(){
    if(selectedId==null) return;
    pushHistory();
    objects = objects.filter(o=>o.id!==selectedId);
    selectedId = null;
    render(); closePopover(); hideFloatBar();
  }
  document.getElementById('btnForward').addEventListener('click', ()=>{
    const i = objects.findIndex(o=>o.id===selectedId);
    if(i<0 || i===objects.length-1) return;
    pushHistory();
    [objects[i],objects[i+1]]=[objects[i+1],objects[i]]; render();
  });
  document.getElementById('btnBackward').addEventListener('click', ()=>{
    const i = objects.findIndex(o=>o.id===selectedId);
    if(i<=0) return;
    pushHistory();
    [objects[i],objects[i-1]]=[objects[i-1],objects[i]]; render();
  });
  document.getElementById('btnClear').addEventListener('click', ()=>{
    if(objects.length===0) return;
    if(confirm('¿Vaciar todo el lienzo? Esta acción no se puede deshacer.')){
      pushHistory();
      objects=[]; selectedId=null; render(); closePopover(); hideFloatBar();
    }
  });

  document.getElementById('btnUndo').addEventListener('click', undo);
  document.getElementById('btnRedo').addEventListener('click', redo);
  document.getElementById('btnCopy').addEventListener('click', copySelectedObject);
  document.getElementById('btnCut').addEventListener('click', cutSelectedObject);
  document.getElementById('btnPaste').addEventListener('click', pasteObject);
  updateUndoRedoButtons();

  window.addEventListener('keydown', e=>{
    const tag = document.activeElement && document.activeElement.tagName;
    if(tag==='INPUT' || tag==='TEXTAREA') return; // deja que el navegador maneje copiar/pegar texto normal
    const key = e.key.toLowerCase();
    if((e.ctrlKey||e.metaKey) && key==='z' && !e.shiftKey){ e.preventDefault(); undo(); }
    else if((e.ctrlKey||e.metaKey) && (key==='y' || (key==='z' && e.shiftKey))){ e.preventDefault(); redo(); }
    else if((e.ctrlKey||e.metaKey) && key==='c'){ e.preventDefault(); copySelectedObject(); }
    else if((e.ctrlKey||e.metaKey) && key==='x'){ e.preventDefault(); cutSelectedObject(); }
    else if((e.ctrlKey||e.metaKey) && key==='v'){ e.preventDefault(); pasteObject(); }
  });
  document.getElementById('btnDownload').addEventListener('click', ()=>{
    const prevSel = selectedId;
    selectedId = null; guide={x:null,y:null};
    render();
    const link = document.createElement('a');
    link.download = 'etiqueta.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    selectedId = prevSel;
    render();
  });

  // ================= guardar / abrir plantilla (diseño editable) =================
  function serializeTemplate(){
    return {
      appId: 'etiquetas-escolares-template',
      version: 1,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      unit, dpi,
      canvasBg, borderW, borderColorValue,
      nextId, nextListId, nextGroupId,
      objects: objects.map(o=>{
        const copy = Object.assign({}, o);
        if(o.type==='image'){
          copy.imgSrc = o.img ? o.img.src : null;
          delete copy.img;
        }
        return copy;
      }),
      dataLists
    };
  }
  document.getElementById('btnSaveTemplate').addEventListener('click', ()=>{
    if(batchPreviewActive) restoreBatchPreview();
    const data = JSON.stringify(serializeTemplate());
    const blob = new Blob([data], {type:'application/json'});
    const link = document.createElement('a');
    link.download = 'plantilla-etiqueta.json';
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(()=> URL.revokeObjectURL(link.href), 4000);
  });

  function loadTemplateFromData(data){
    if(!data || !Array.isArray(data.objects)){ alert('El archivo no parece ser una plantilla válida.'); return; }
    closePopover(); hideFloatBar();
    if(batchPreviewActive) restoreBatchPreview();
    selectedId = null; guide={x:null,y:null};

    if(data.canvasWidth && data.canvasHeight){ canvas.width=data.canvasWidth; canvas.height=data.canvasHeight; }
    if(data.unit) unit = data.unit;
    if(data.dpi) dpi = data.dpi;
    if(data.canvasBg) canvasBg = data.canvasBg;
    if(data.borderW!=null) borderW = data.borderW;
    if(data.borderColorValue) borderColorValue = data.borderColorValue;

    let pending = 0;
    const restored = data.objects.map(raw=>{
      const o = Object.assign({}, raw);
      if(o.type==='image' && o.imgSrc){
        const img = new Image();
        pending++;
        img.onload = ()=>{ pending--; render(); };
        img.src = o.imgSrc;
        o.img = img;
        delete o.imgSrc;
      }
      return o;
    });
    objects = restored;
    nextId = data.nextId || (Math.max(0, ...objects.map(o=>o.id||0)) + 1);
    dataLists = Array.isArray(data.dataLists) ? data.dataLists : [];
    nextListId = data.nextListId || (Math.max(0, ...dataLists.map(l=>l.id||0)) + 1);
    nextGroupId = data.nextGroupId || (Math.max(0, ...dataLists.flatMap(l=>(l.groups||[]).map(g=>g.id||0))) + 1);

    render();
  }
  document.getElementById('templateFileInput').addEventListener('change', e=>{
    const file = e.target.files[0];
    e.target.value = '';
    if(!file) return;
    const reader = new FileReader();
    reader.onload = ev=>{
      try{ loadTemplateFromData(JSON.parse(ev.target.result)); }
      catch(err){ alert('No se pudo leer el archivo. Asegúrate de que sea una plantilla exportada desde este taller.'); }
    };
    reader.readAsText(file);
  });

  // ================= rendering =================
  function styleAt(o, idx){
    let s = { bold:!!o.bold, italic:!!o.italic, underline:false, strike:false };
    if(o.richRanges){
      o.richRanges.forEach(r=>{
        if(idx>=r.start && idx<r.end){
          if(r.bold!=null) s.bold=r.bold;
          if(r.italic!=null) s.italic=r.italic;
          if(r.underline!=null) s.underline=r.underline;
          if(r.strike!=null) s.strike=r.strike;
        }
      });
    }
    return s;
  }
  function fontFor(o, st){ return `${st.italic?'italic':'normal'} ${st.bold?'700':'400'} ${o.fontSize}px "${o.fontFamily}"`; }
  function measureRichWidth(ctxRef, o, text, startOffset){
    if(text.length===0) return 0;
    let w = 0, i = 0;
    while(i<text.length){
      const st = styleAt(o, startOffset+i);
      let j = i+1;
      while(j<text.length){
        const st2 = styleAt(o, startOffset+j);
        if(st2.bold!==st.bold || st2.italic!==st.italic) break;
        j++;
      }
      ctxRef.font = fontFor(o, st);
      w += ctxRef.measureText(text.slice(i,j)).width;
      i = j;
    }
    return w;
  }
  function buildWrappedLines(ctxRef, o, text, maxWidth){
    const paragraphs = text.split(/\r\n|\r|\n/);
    const lines = [];
    let offset = 0;
    paragraphs.forEach(par=>{
      if(par===''){
        lines.push({text:'', start:offset});
      } else {
        const words = par.split(' ');
        let line='', lineStartOffset=offset, pos=offset;
        words.forEach(w=>{
          const wordStart = pos;
          const test = line ? line+' '+w : w;
          if(measureRichWidth(ctxRef, o, test, lineStartOffset) > maxWidth && line){
            lines.push({text:line, start:lineStartOffset});
            line = w; lineStartOffset = wordStart;
          } else { line = test; }
          pos = wordStart + w.length + 1;
        });
        lines.push({text:line, start:lineStartOffset});
      }
      offset += par.length + 1;
    });
    return lines;
  }
  function lineRuns(o, line){
    const runs = []; let cur = null;
    for(let i=0;i<line.text.length;i++){
      const st = styleAt(o, line.start+i);
      if(cur && cur.bold===st.bold && cur.italic===st.italic && cur.underline===st.underline && cur.strike===st.strike){
        cur.text += line.text[i];
      } else { cur = {text:line.text[i], ...st}; runs.push(cur); }
    }
    if(runs.length===0) runs.push({text:'', bold:!!o.bold, italic:!!o.italic, underline:false, strike:false});
    return runs;
  }
  // ajusta w/h del cuadro de texto al contenido real (sin forzar saltos de línea automáticos),
  // manteniendo el centro del objeto fijo para que no "salte" al redimensionarse.
  function computeAutoSize(o){
    if(o.textShape && o.textShape!=='recta') return; // no aplica a texto curvo
    const rawLines = o.content.split(/\r\n|\r|\n/);
    let offset = 0;
    const lineObjs = rawLines.map(text=>{ const lo = {text, start:offset}; offset += text.length+1; return lo; });
    let maxWidth = 0;
    lineObjs.forEach(line=>{
      const runs = lineRuns(o, line);
      let w = 0;
      runs.forEach(r=>{ ctx.font = fontFor(o,r); w += ctx.measureText(r.text).width; });
      if(w>maxWidth) maxWidth = w;
    });
    const lineHeight = o.fontSize*1.15;
    const strokeExtra = o.strokeEnabled ? (o.strokeWidth||0) : 0;
    const padX = 26 + strokeExtra*2, padY = 20 + strokeExtra*2;
    const newW = Math.max(40, Math.ceil(maxWidth + padX));
    const newH = Math.max(28, Math.ceil(lineObjs.length*lineHeight + padY));
    // el borde que se mantiene fijo depende de la alineación: así, textos alineados a la
    // izquierda/derecha crecen solo hacia un lado (no descuadran el inicio del texto al sustituir variables)
    let newX;
    if(o.align==='left') newX = o.x;
    else if(o.align==='right') newX = o.x + o.w - newW;
    else newX = o.x + o.w/2 - newW/2;
    const cy = o.y + o.h/2;
    o.w = newW; o.h = newH;
    o.x = newX; o.y = cy - o.h/2;
  }
  function drawWrappedRichText(ctxRef,o,x,y,maxWidth,lineHeight,fillStyle,strokeStyleStr){
    const lines = buildWrappedLines(ctxRef, o, o.content, maxWidth);
    const totalH = lines.length*lineHeight;
    let startY = y - totalH/2 + lineHeight/2;
    lines.forEach((line,li)=>{
      const ly = startY + li*lineHeight;
      const runs = lineRuns(o, line);
      const widths = runs.map(r=>{ ctxRef.font = fontFor(o,r); return ctxRef.measureText(r.text).width; });
      const lineWidth = widths.reduce((a,b)=>a+b,0);
      let cx = o.align==='center' ? x-lineWidth/2 : (o.align==='right' ? x-lineWidth : x);
      ctxRef.textAlign='left'; ctxRef.textBaseline='middle';
      if(o.shadowEnabled){ ctxRef.shadowColor=o.shadowColor; ctxRef.shadowBlur=o.shadowBlur; ctxRef.shadowOffsetX=o.shadowOffsetX; ctxRef.shadowOffsetY=o.shadowOffsetY; }
      else { ctxRef.shadowColor='rgba(0,0,0,0)'; }
      runs.forEach((r,ri)=>{
        ctxRef.font = fontFor(o,r);
        const w = widths[ri];
        if(strokeStyleStr){ ctxRef.strokeStyle=strokeStyleStr; ctxRef.lineWidth=o.strokeWidth; ctxRef.strokeText(r.text, cx, ly); }
        ctxRef.fillStyle = fillStyle;
        ctxRef.fillText(r.text, cx, ly);
        if(r.underline || r.strike){
          ctxRef.save(); ctxRef.shadowColor='rgba(0,0,0,0)';
          ctxRef.strokeStyle = fillStyle; ctxRef.lineWidth = Math.max(1, o.fontSize*0.06);
          if(r.underline){ const uy = ly+o.fontSize*0.34; ctxRef.beginPath(); ctxRef.moveTo(cx,uy); ctxRef.lineTo(cx+w,uy); ctxRef.stroke(); }
          if(r.strike){ ctxRef.beginPath(); ctxRef.moveTo(cx,ly); ctxRef.lineTo(cx+w,ly); ctxRef.stroke(); }
          ctxRef.restore();
        }
        cx += w;
      });
    });
  }
  function roundRect(ctxRef,x,y,w,h,r){
    ctxRef.beginPath(); ctxRef.moveTo(x+r,y);
    ctxRef.arcTo(x+w,y,x+w,y+h,r); ctxRef.arcTo(x+w,y+h,x,y+h,r);
    ctxRef.arcTo(x,y+h,x,y,r); ctxRef.arcTo(x,y,x+w,y,r); ctxRef.closePath();
  }
  function drawCurvedText(ctxRef, text, cx, cy, o, fillStyle, strokeStyleStr){
    const chars = text.split('');
    if(chars.length===0) return;
    const radius = Math.max(24, 8000/Math.max(1,o.curveAmount||40));
    const totalWidth = chars.reduce((s,c)=>s+ctxRef.measureText(c).width,0);
    let totalAngle = Math.min(totalWidth/radius, Math.PI*1.6);
    let theta = -totalAngle/2;
    ctxRef.textAlign='center'; ctxRef.textBaseline='middle';
    const up = o.textShape==='curva-arriba';
    const circCy = up ? cy+radius : cy-radius;
    chars.forEach(ch=>{
      const chW = ctxRef.measureText(ch).width;
      const chAngle = chW/radius;
      const mid = theta + chAngle/2;
      const px = cx + Math.sin(mid)*radius;
      let py, rot;
      if(up){ py = circCy - Math.cos(mid)*radius; rot = mid; }
      else { py = circCy + Math.cos(mid)*radius; rot = -mid; }
      ctxRef.save();
      ctxRef.translate(px,py); ctxRef.rotate(rot);
      if(o.shadowEnabled){ ctxRef.shadowColor=o.shadowColor; ctxRef.shadowBlur=o.shadowBlur; ctxRef.shadowOffsetX=o.shadowOffsetX; ctxRef.shadowOffsetY=o.shadowOffsetY; }
      if(strokeStyleStr){ ctxRef.strokeStyle=strokeStyleStr; ctxRef.lineWidth=o.strokeWidth; ctxRef.strokeText(ch,0,0); }
      ctxRef.fillStyle = fillStyle;
      ctxRef.fillText(ch,0,0);
      ctxRef.restore();
      theta += chAngle;
    });
  }
  function drawTextObj(o){
    ctx.save();
    ctx.globalAlpha = (o.opacity!=null?o.opacity:100)/100;
    if(o.bgShape !== 'none'){
      ctx.fillStyle = styleFor(ctx,o.bgColor,o.x,o.y,o.w,o.h);
      ctx.strokeStyle = styleFor(ctx,o.borderColor,o.x,o.y,o.w,o.h);
      ctx.lineWidth = o.borderWidth;
      if(o.bgShape==='rect'){ ctx.beginPath(); ctx.rect(o.x,o.y,o.w,o.h); ctx.fill(); if(o.borderWidth>0) ctx.stroke(); }
      else if(o.bgShape==='rounded'){ const r=Math.min(o.w,o.h)*0.18; roundRect(ctx,o.x,o.y,o.w,o.h,r); ctx.fill(); if(o.borderWidth>0) ctx.stroke(); }
      else if(o.bgShape==='circle'){ ctx.beginPath(); ctx.ellipse(o.x+o.w/2,o.y+o.h/2,o.w/2,o.h/2,0,0,Math.PI*2); ctx.fill(); if(o.borderWidth>0) ctx.stroke(); }
    }
    let fw=o.bold?'700':'400', fst=o.italic?'italic':'normal';
    ctx.font = `${fst} ${fw} ${o.fontSize}px "${o.fontFamily}"`;
    const fillStyle = styleFor(ctx,o.color,o.x,o.y,o.w,o.h);
    const strokeStyleStr = o.strokeEnabled ? styleFor(ctx,o.strokeColor,o.x,o.y,o.w,o.h) : null;
    if(o.textShape && o.textShape!=='recta'){
      drawCurvedText(ctx, o.content.replace(/\n/g,' '), o.x+o.w/2, o.y+o.h/2, o, fillStyle, strokeStyleStr);
    } else {
      ctx.textAlign = o.align; ctx.textBaseline='middle';
      const tx = o.align==='center' ? o.x+o.w/2 : (o.align==='right' ? o.x+o.w-8 : o.x+8);
      drawWrappedRichText(ctx, o, tx, o.y+o.h/2, o.w-12, o.fontSize*1.15, fillStyle, strokeStyleStr);
    }
    ctx.restore();
  }
  function drawImageObj(o){
    ctx.save();
    ctx.globalAlpha = (o.opacity!=null?o.opacity:100)/100;
    const filters=[];
    if(o.brightness!=null && o.brightness!==100) filters.push(`brightness(${o.brightness}%)`);
    if(o.contrast!=null && o.contrast!==100) filters.push(`contrast(${o.contrast}%)`);
    if(o.saturate!=null && o.saturate!==100) filters.push(`saturate(${o.saturate}%)`);
    if(o.grayscale) filters.push(`grayscale(${o.grayscale}%)`);
    if(o.sepia) filters.push(`sepia(${o.sepia}%)`);
    if(o.blur) filters.push(`blur(${o.blur}px)`);
    ctx.filter = filters.length ? filters.join(' ') : 'none';
    if(o.cornerShape==='circle'){ ctx.beginPath(); ctx.ellipse(o.x+o.w/2,o.y+o.h/2,o.w/2,o.h/2,0,0,Math.PI*2); ctx.clip(); }
    else if(o.cornerShape==='rounded'){ const r=Math.min(o.w,o.h)*0.15; roundRect(ctx,o.x,o.y,o.w,o.h,r); ctx.clip(); }
    if(o.flipH || o.flipV){
      const cx=o.x+o.w/2, cy=o.y+o.h/2;
      ctx.translate(cx,cy); ctx.scale(o.flipH?-1:1, o.flipV?-1:1); ctx.translate(-cx,-cy);
    }
    ctx.drawImage(o.img, o.x, o.y, o.w, o.h);
    ctx.restore();
  }

  function render(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = styleFor(ctx, canvasBg, 0,0,canvas.width,canvas.height);
    ctx.fillRect(0,0,canvas.width,canvas.height);

    objects.forEach(o=>{
      ctx.save();
      if(o.rotation){
        const cx=o.x+o.w/2, cy=o.y+o.h/2;
        ctx.translate(cx,cy); ctx.rotate((o.rotation||0)*Math.PI/180); ctx.translate(-cx,-cy);
      }
      if(o.type==='text'){ if(o.autoSize) computeAutoSize(o); drawTextObj(o); } else drawImageObj(o);
      if(o.id===selectedId){
        ctx.save();
        ctx.strokeStyle='#4FBDBA'; ctx.lineWidth=2; ctx.setLineDash([6,4]);
        ctx.strokeRect(o.x,o.y,o.w,o.h);
        ctx.setLineDash([]);
        // resize handle (bottom-right, enlarged for touch) — oculto si el tamaño es automático
        if(!o.autoSize){
          ctx.fillStyle='#4FBDBA';
          ctx.fillRect(o.x+o.w-11, o.y+o.h-11, 22, 22);
          ctx.strokeStyle='#ffffff'; ctx.lineWidth=2;
          ctx.strokeRect(o.x+o.w-11, o.y+o.h-11, 22, 22);
        }
        // rotate handle (top-center)
        const hx=o.x+o.w/2, hy=o.y-32;
        ctx.beginPath(); ctx.moveTo(o.x+o.w/2,o.y); ctx.lineTo(hx,hy);
        ctx.strokeStyle='#4FBDBA'; ctx.lineWidth=2; ctx.stroke();
        ctx.beginPath(); ctx.arc(hx,hy,10,0,Math.PI*2);
        ctx.fillStyle='#4FBDBA'; ctx.fill();
        ctx.strokeStyle='#ffffff'; ctx.lineWidth=2; ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    });

    if(borderW>0){
      ctx.strokeStyle = styleFor(ctx, borderColorValue, 0,0,canvas.width,canvas.height);
      ctx.lineWidth = borderW;
      ctx.strokeRect(borderW/2, borderW/2, canvas.width-borderW, canvas.height-borderW);
    }
    if(guide.x!==null){
      ctx.save(); ctx.strokeStyle='#E8623D'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(guide.x,0); ctx.lineTo(guide.x,canvas.height); ctx.stroke(); ctx.restore();
    }
    if(guide.y!==null){
      ctx.save(); ctx.strokeStyle='#E8623D'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(0,guide.y); ctx.lineTo(canvas.width,guide.y); ctx.stroke(); ctx.restore();
    }
    updateFloatBar();
  }

  // ================= coordinates & rotation-aware hit test =================
  function canvasCoords(clientX,clientY){
    const rect = canvas.getBoundingClientRect();
    return { x:(clientX-rect.left)*(canvas.width/rect.width), y:(clientY-rect.top)*(canvas.height/rect.height) };
  }
  function toScreenRect(o){
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width/canvas.width;
    return { left: rect.left+o.x*scale, top: rect.top+o.y*scale, width:o.w*scale, height:o.h*scale };
  }
  function toLocal(o, px, py){
    if(!o.rotation) return {x:px,y:py};
    const cx=o.x+o.w/2, cy=o.y+o.h/2;
    const rad=-(o.rotation*Math.PI/180);
    const dx=px-cx, dy=py-cy;
    return { x: dx*Math.cos(rad)-dy*Math.sin(rad)+cx, y: dx*Math.sin(rad)+dy*Math.cos(rad)+cy };
  }
  function toLocalFixed(px,py,cx,cy,rotationDeg){
    const rad=-((rotationDeg||0)*Math.PI/180);
    const dx=px-cx, dy=py-cy;
    return { x: dx*Math.cos(rad)-dy*Math.sin(rad)+cx, y: dx*Math.sin(rad)+dy*Math.cos(rad)+cy };
  }
  function hitTest(px,py){
    for(let i=objects.length-1;i>=0;i--){
      const o=objects[i];
      const loc = toLocal(o,px,py);
      if(loc.x>=o.x && loc.x<=o.x+o.w && loc.y>=o.y && loc.y<=o.y+o.h) return o;
    }
    return null;
  }
  function touchThreshold(){
    const rect = canvas.getBoundingClientRect();
    return 24*(canvas.width/rect.width);
  }
  function nearHandle(o,px,py){
    if(!o) return false;
    const th = touchThreshold();
    const loc = toLocal(o,px,py);
    return Math.abs(loc.x-(o.x+o.w))<th && Math.abs(loc.y-(o.y+o.h))<th;
  }
  function nearRotateHandle(o,px,py){
    if(!o) return false;
    const th = touchThreshold();
    const loc = toLocal(o,px,py);
    const hx=o.x+o.w/2, hy=o.y-32;
    return Math.hypot(loc.x-hx, loc.y-hy) < th;
  }

  // ================= snapping =================
  function computeSnap(sel){
    const rect = canvas.getBoundingClientRect();
    const threshold = 8*(canvas.width/rect.width);
    const selCX=sel.x+sel.w/2, selCY=sel.y+sel.h/2;
    const selL=sel.x, selR=sel.x+sel.w, selT=sel.y, selB=sel.y+sel.h;
    const xCandidates=[0, canvas.width/2, canvas.width];
    const yCandidates=[0, canvas.height/2, canvas.height];
    objects.forEach(o=>{
      if(o.id===sel.id) return;
      xCandidates.push(o.x, o.x+o.w/2, o.x+o.w);
      yCandidates.push(o.y, o.y+o.h/2, o.y+o.h);
    });
    let bestDX=0, bestXLine=null, bestXDist=Infinity;
    [selL,selCX,selR].forEach(v=>{
      xCandidates.forEach(cx=>{
        const d=Math.abs(v-cx);
        if(d<threshold && d<bestXDist){ bestXDist=d; bestXLine=cx; bestDX=cx-v; }
      });
    });
    let bestDY=0, bestYLine=null, bestYDist=Infinity;
    [selT,selCY,selB].forEach(v=>{
      yCandidates.forEach(cy=>{
        const d=Math.abs(v-cy);
        if(d<threshold && d<bestYDist){ bestYDist=d; bestYLine=cy; bestDY=cy-v; }
      });
    });
    return { dx:bestDX, dy:bestDY, lineX:bestXLine, lineY:bestYLine };
  }

  // ================= drag / resize / rotate / long-press =================
  let dragMode=null, dragStart={x:0,y:0}, objStart={}, pressTimer=null, moved=false;
  let pinchState = null;
  let viewPinchState = null;

  function startViewPinch(t1,t2){
    viewPinchState = {
      startDist: touchDist(t1,t2),
      startZoom: viewZoom,
      startMidX: (t1.clientX+t2.clientX)/2,
      startMidY: (t1.clientY+t2.clientY)/2,
      startScrollLeft: workspace.scrollLeft,
      startScrollTop: workspace.scrollTop
    };
  }
  function moveViewPinch(t1,t2){
    const d = touchDist(t1,t2);
    setViewZoom(viewPinchState.startZoom * (d/viewPinchState.startDist));
    const midX=(t1.clientX+t2.clientX)/2, midY=(t1.clientY+t2.clientY)/2;
    workspace.scrollLeft = viewPinchState.startScrollLeft - (midX-viewPinchState.startMidX);
    workspace.scrollTop = viewPinchState.startScrollTop - (midY-viewPinchState.startMidY);
  }

  function pointerDown(clientX, clientY){
    closeAllDropdowns();
    const {x,y} = canvasCoords(clientX, clientY);
    const sel = objects.find(o=>o.id===selectedId);
    if(sel && nearRotateHandle(sel,x,y)){
      const cx=sel.x+sel.w/2, cy=sel.y+sel.h/2;
      dragMode='rotate';
      objStart = { cx, cy, startAngle: Math.atan2(y-cy,x-cx), startRotation: sel.rotation||0 };
      pendingSnapshot = snapshotState();
      return;
    }
    if(sel && !sel.autoSize && nearHandle(sel,x,y)){
      dragMode='resize'; dragStart={x,y};
      objStart={w:sel.w,h:sel.h,x:sel.x,y:sel.y,rotation:sel.rotation||0,cx:sel.x+sel.w/2,cy:sel.y+sel.h/2};
      pendingSnapshot = snapshotState();
      return;
    }
    const hit = hitTest(x,y);
    if(hit){
      selectedId = hit.id;
      dragMode='move'; dragStart={x,y}; objStart={x:hit.x,y:hit.y};
      pendingSnapshot = snapshotState();
      moved=false;
      pressTimer = setTimeout(()=>{
        if(!moved){ dragMode=null; openPopover(clientX, clientY, hit); }
      }, 480);
    } else {
      selectedId = null; closePopover();
    }
    render();
  }
  function pointerMove(clientX, clientY){
    if(!dragMode) return;
    const {x,y} = canvasCoords(clientX, clientY);
    const dxTotal=x-dragStart.x, dyTotal=y-dragStart.y;
    if(Math.abs(dxTotal)>3 || Math.abs(dyTotal)>3){
      moved=true;
      if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; }
    }
    const sel = objects.find(o=>o.id===selectedId);
    if(!sel) return;
    if(dragMode==='move'){
      sel.x = objStart.x+dxTotal; sel.y = objStart.y+dyTotal;
      const snap = computeSnap(sel);
      sel.x += snap.dx; sel.y += snap.dy;
      guide.x = snap.lineX; guide.y = snap.lineY;
    } else if(dragMode==='resize'){
      const local = toLocalFixed(x,y,objStart.cx,objStart.cy,objStart.rotation);
      sel.w = Math.max(20, local.x-objStart.x);
      sel.h = Math.max(20, local.y-objStart.y);
    } else if(dragMode==='rotate'){
      const ang = Math.atan2(y-objStart.cy, x-objStart.cx);
      const deltaDeg = (ang-objStart.startAngle)*180/Math.PI;
      sel.rotation = Math.round(objStart.startRotation + deltaDeg);
    }
    render();
  }
  function pointerUp(){
    if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; }
    if(dragMode && moved && pendingSnapshot) commitPendingSnapshot();
    else pendingSnapshot = null;
    dragMode=null; guide={x:null,y:null}; render();
  }
  function commitPendingSnapshot(){
    if(!pendingSnapshot) return;
    history.push(pendingSnapshot);
    if(history.length>HISTORY_LIMIT) history.shift();
    future = [];
    updateUndoRedoButtons();
    pendingSnapshot = null;
  }
  function touchDist(t1,t2){ return Math.hypot(t2.clientX-t1.clientX, t2.clientY-t1.clientY); }
  function touchAngle(t1,t2){ return Math.atan2(t2.clientY-t1.clientY, t2.clientX-t1.clientX); }

  canvas.addEventListener('mousedown', e=>{ e.preventDefault(); pointerDown(e.clientX,e.clientY); });
  window.addEventListener('mousemove', e=> pointerMove(e.clientX,e.clientY));
  window.addEventListener('mouseup', pointerUp);

  canvas.addEventListener('touchstart', e=>{
    if(e.touches.length===2){
      e.preventDefault();
      if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; }
      dragMode=null;
      const [t1,t2] = e.touches;
      const sel = objects.find(o=>o.id===selectedId);
      let overSelected = false;
      if(sel){
        const midX=(t1.clientX+t2.clientX)/2, midY=(t1.clientY+t2.clientY)/2;
        const {x,y} = canvasCoords(midX, midY);
        const loc = toLocal(sel, x, y);
        overSelected = !sel.autoSize && loc.x>=sel.x && loc.x<=sel.x+sel.w && loc.y>=sel.y && loc.y<=sel.y+sel.h;
      }
      if(overSelected){
        pinchState = { startDist: touchDist(t1,t2), startAngle: touchAngle(t1,t2), startW: sel.w, startH: sel.h, startRotation: sel.rotation||0 };
        pendingSnapshot = snapshotState();
      } else {
        startViewPinch(t1,t2);
      }
      return;
    }
    const t=e.touches[0]; pointerDown(t.clientX,t.clientY);
  }, {passive:false});
  window.addEventListener('touchmove', e=>{
    if(pinchState && e.touches.length===2){
      e.preventDefault();
      const sel = objects.find(o=>o.id===selectedId);
      if(!sel){ pinchState=null; return; }
      const [t1,t2] = e.touches;
      const d = touchDist(t1,t2);
      const ang = touchAngle(t1,t2);
      const scale = d/pinchState.startDist;
      sel.w = Math.max(20, pinchState.startW*scale);
      sel.h = Math.max(20, pinchState.startH*scale);
      sel.rotation = Math.round(pinchState.startRotation + (ang-pinchState.startAngle)*180/Math.PI);
      render();
      return;
    }
    if(viewPinchState && e.touches.length===2){
      e.preventDefault();
      const [t1,t2] = e.touches;
      moveViewPinch(t1,t2);
      return;
    }
    if(!dragMode) return;
    const t=e.touches[0]; pointerMove(t.clientX,t.clientY);
  }, {passive:false});
  window.addEventListener('touchend', e=>{
    if(e.touches.length<2){
      if(pinchState && pendingSnapshot) commitPendingSnapshot();
      pinchState=null; viewPinchState=null;
    }
    pointerUp();
  });

  // pellizco de dos dedos fuera del canvas (sobre el fondo del workspace) también hace zoom/desplazamiento
  workspace.addEventListener('touchstart', e=>{
    if(e.target===canvas) return;
    if(e.touches.length===2){
      e.preventDefault();
      const [t1,t2] = e.touches;
      startViewPinch(t1,t2);
    }
  }, {passive:false});
  canvas.addEventListener('contextmenu', e=>{
    e.preventDefault();
    const {x,y} = canvasCoords(e.clientX,e.clientY);
    const hit = hitTest(x,y);
    if(hit){ selectedId=hit.id; render(); openPopover(e.clientX,e.clientY,hit); }
  });

  // ================= floating quick toolbar =================
  const floatBar = document.getElementById('floatBar');
  let floatDragState = null;
  let floatBarManualPos = null; // {left,top} tras arrastrarla a mano
  let floatBarPosForId = null;  // a qué objeto corresponde esa posición manual
  function floatDragMove(clientX, clientY){
    if(!floatDragState) return;
    const pw = floatBar.offsetWidth, ph = floatBar.offsetHeight;
    let left = floatDragState.startLeft + (clientX-floatDragState.startX);
    let top = floatDragState.startTop + (clientY-floatDragState.startY);
    left = Math.max(4, Math.min(left, window.innerWidth-pw-4));
    top = Math.max(4, Math.min(top, window.innerHeight-ph-4));
    floatBar.style.left = left+'px'; floatBar.style.top = top+'px';
    floatBarManualPos = {left, top};
    floatBarPosForId = selectedId;
  }
  window.addEventListener('mousemove', e=> floatDragMove(e.clientX, e.clientY));
  window.addEventListener('mouseup', ()=>{
    floatDragState=null;
    const g=document.getElementById('floatBarGrip'); if(g) g.classList.remove('dragging');
  });
  window.addEventListener('touchmove', e=>{
    if(floatDragState && e.touches.length===1){ const t=e.touches[0]; floatDragMove(t.clientX,t.clientY); }
  }, {passive:true});
  window.addEventListener('touchend', ()=>{
    floatDragState=null;
    const g=document.getElementById('floatBarGrip'); if(g) g.classList.remove('dragging');
  });
  function wireFloatBarDrag(){
    const grip = document.getElementById('floatBarGrip');
    if(!grip) return;
    grip.addEventListener('mousedown', e=>{
      e.preventDefault();
      const rect = floatBar.getBoundingClientRect();
      floatDragState = {startX:e.clientX, startY:e.clientY, startLeft:rect.left, startTop:rect.top};
      grip.classList.add('dragging');
    });
    grip.addEventListener('touchstart', e=>{
      const rect = floatBar.getBoundingClientRect();
      const t = e.touches[0];
      floatDragState = {startX:t.clientX, startY:t.clientY, startLeft:rect.left, startTop:rect.top};
      grip.classList.add('dragging');
    }, {passive:true});
  }
  function updateFloatBar(){
    const sel = objects.find(o=>o.id===selectedId);
    if(!sel){ floatBar.style.display='none'; floatBarManualPos=null; floatBarPosForId=null; return; }
    const r = toScreenRect(sel);
    floatBar.innerHTML = `
      <span class="fbGrip" id="floatBarGrip" title="Arrastrar">⠿</span>
      <button id="fb_edit">✏️ Editar</button>
      <button id="fb_up" title="Adelante">↑</button>
      <button id="fb_down" title="Atrás">↓</button>
      <button id="fb_del" title="Eliminar">🗑</button>`;
    floatBar.style.display='flex';
    if(floatBarManualPos && floatBarPosForId===sel.id){
      floatBar.style.top = floatBarManualPos.top+'px'; floatBar.style.left = floatBarManualPos.left+'px';
    } else {
      floatBarManualPos = null;
      let top = r.top - 46; if(top<6) top = r.top+r.height+6;
      let left = Math.min(Math.max(r.left,6), window.innerWidth-200);
      floatBar.style.top = top+'px'; floatBar.style.left = left+'px';
    }
    document.getElementById('fb_edit').onclick = e=>{ e.stopPropagation(); openPopover(r.left,r.top,sel); };
    document.getElementById('fb_up').onclick = e=>{ e.stopPropagation(); document.getElementById('btnForward').click(); };
    document.getElementById('fb_down').onclick = e=>{ e.stopPropagation(); document.getElementById('btnBackward').click(); };
    document.getElementById('fb_del').onclick = e=>{ e.stopPropagation(); deleteSelected(); };
    wireFloatBarDrag();
  }
  function hideFloatBar(){ floatBar.style.display='none'; floatBarManualPos=null; floatBarPosForId=null; }

  // ================= WordArt presets =================
  const WORDART_PRESETS = {
    arcoiris: sel=>{
      sel.color = {type:'gradient', angle:90, stops:[{hex:'#FF5B5B',pos:0},{hex:'#F2C14E',pos:50},{hex:'#4FBDBA',pos:100}]};
      sel.bold = true; sel.strokeEnabled=false; sel.shadowEnabled=false;
    },
    neon: sel=>{
      sel.color = {type:'solid', hex:'#7CF5E8'};
      sel.strokeEnabled=false;
      sel.shadowEnabled=true; sel.shadowColor='#00eaff'; sel.shadowBlur=24; sel.shadowOffsetX=0; sel.shadowOffsetY=0;
    },
    comic: sel=>{
      sel.fontFamily='Bangers';
      sel.color = {type:'solid', hex:'#F2C14E'};
      sel.strokeEnabled=true; sel.strokeColor={type:'solid',hex:'#1B2A28'}; sel.strokeWidth=5;
      sel.shadowEnabled=false;
    },
    oro: sel=>{
      sel.color = {type:'gradient', angle:90, stops:[{hex:'#8a5a12',pos:0},{hex:'#f2d17a',pos:50},{hex:'#8a5a12',pos:100}]};
      sel.strokeEnabled=true; sel.strokeColor={type:'solid',hex:'#5c3a0a'}; sel.strokeWidth=1;
      sel.shadowEnabled=false;
    },
    fuego: sel=>{
      sel.color = {type:'gradient', angle:90, stops:[{hex:'#FFD23F',pos:0},{hex:'#EE4B2B',pos:60},{hex:'#8B0000',pos:100}]};
      sel.strokeEnabled=false;
      sel.shadowEnabled=true; sel.shadowColor='#ff6a00'; sel.shadowBlur=18; sel.shadowOffsetX=0; sel.shadowOffsetY=0;
    },
    limpio: sel=>{
      sel.strokeEnabled=false; sel.shadowEnabled=false;
      sel.color = {type:'solid', hex:'#1B2A28'};
    }
  };

  // ================= object edit popover =================
  const popover = document.getElementById('popover');
  function closePopover(){ popover.style.display='none'; }

  // arrastre del popover desde su cabecera/punto, para reubicarlo cuando estorba
  let popDragState = null;
  function popDragMove(clientX, clientY){
    if(!popDragState) return;
    const pw = popover.offsetWidth, ph = popover.offsetHeight;
    let left = popDragState.startLeft + (clientX-popDragState.startX);
    let top = popDragState.startTop + (clientY-popDragState.startY);
    left = Math.max(4, Math.min(left, window.innerWidth-pw-4));
    top = Math.max(4, Math.min(top, window.innerHeight-ph-4));
    popover.style.left = left+'px'; popover.style.top = top+'px';
  }
  window.addEventListener('mousemove', e=> popDragMove(e.clientX, e.clientY));
  window.addEventListener('mouseup', ()=>{
    popDragState=null;
    const h=document.getElementById('popDragHandle'); if(h) h.classList.remove('dragging');
  });
  window.addEventListener('touchmove', e=>{
    if(popDragState && e.touches.length===1){ const t=e.touches[0]; popDragMove(t.clientX,t.clientY); }
  }, {passive:true});
  window.addEventListener('touchend', ()=>{
    popDragState=null;
    const h=document.getElementById('popDragHandle'); if(h) h.classList.remove('dragging');
  });
  function wirePopoverDrag(){
    const handle = document.getElementById('popDragHandle');
    if(!handle) return;
    handle.addEventListener('mousedown', e=>{
      if(e.target.closest('.popClose')) return;
      e.preventDefault();
      const rect = popover.getBoundingClientRect();
      popDragState = {startX:e.clientX, startY:e.clientY, startLeft:rect.left, startTop:rect.top};
      handle.classList.add('dragging');
    });
    handle.addEventListener('touchstart', e=>{
      if(e.target.closest('.popClose')) return;
      const rect = popover.getBoundingClientRect();
      const t = e.touches[0];
      popDragState = {startX:t.clientX, startY:t.clientY, startLeft:rect.left, startTop:rect.top};
      handle.classList.add('dragging');
    }, {passive:true});
  }

  // posiciona el popover evitando tapar el objeto seleccionado: intenta debajo, arriba, a la derecha, a la izquierda
  function positionPopoverSmart(sel){
    popover.style.left='-9999px'; popover.style.top='-9999px';
    const pw = popover.offsetWidth || 280, ph = popover.offsetHeight || 300;
    const objRect = toScreenRect(sel);
    const vw = window.innerWidth, vh = window.innerHeight, margin = 12;
    const centeredLeft = objRect.left + objRect.width/2 - pw/2;
    const candidates = [
      { left: centeredLeft, top: objRect.top+objRect.height+margin },
      { left: centeredLeft, top: objRect.top-ph-margin },
      { left: objRect.left+objRect.width+margin, top: objRect.top },
      { left: objRect.left-pw-margin, top: objRect.top }
    ];
    let chosen = candidates.find(c=> c.left>=4 && c.left+pw<=vw-4 && c.top>=4 && c.top+ph<=vh-4);
    if(!chosen){
      chosen = { left: Math.min(Math.max(centeredLeft,4), vw-pw-4), top: Math.max(4, Math.min(objRect.top+objRect.height+margin, vh-ph-4)) };
    }
    const left = Math.min(Math.max(chosen.left,4), vw-pw-4);
    const top = Math.min(Math.max(chosen.top,4), vh-ph-4);
    popover.style.left=left+'px'; popover.style.top=top+'px';
  }

  function openPopover(clientX, clientY, sel){
    pushHistory();
    popover.innerHTML = buildPopoverContent(sel);
    popover.style.display='block';
    positionPopoverSmart(sel);
    popover.addEventListener('click', e=> e.stopPropagation(), {once:true});
    wirePopover(sel);
    wirePopoverDrag();
  }
  function refreshPopoverInPlace(sel){
    popover.innerHTML = buildPopoverContent(sel);
    popover.addEventListener('click', e=> e.stopPropagation(), {once:true});
    wirePopover(sel);
    wirePopoverDrag();
  }
  function buildPopoverContent(sel){
    const title = sel.type==='text' ? 'Texto' : 'Imagen';
    let body = '';
    if(sel.type==='text'){
      body = `
        <label class="colChk" style="margin-bottom:10px;font-size:12.5px">
          <input type="checkbox" id="p_autosize" ${sel.autoSize?'checked':''}> Ajustar el tamaño del cuadro automáticamente al texto
        </label>
        <label class="field">Contenido (admite varias líneas)<textarea id="p_content">${escapeHtml(sel.content)}</textarea></label>
        <p class="hint">Selecciona una palabra o frase arriba para aplicar el formato solo a esa parte. Si no seleccionas nada, se aplica a todo el texto.</p>
        <div class="richRow">
          <button type="button" id="p_rich_bold" title="Negrita a la selección"><b>N</b></button>
          <button type="button" id="p_rich_italic" title="Cursiva a la selección"><i>K</i></button>
          <button type="button" id="p_rich_underline" title="Subrayado a la selección"><u>S</u></button>
          <button type="button" id="p_rich_strike" title="Tachado a la selección"><s>T</s></button>
        </div>
        <button type="button" class="small block" id="p_rich_clear" style="margin-bottom:14px">Quitar formato de la selección</button>
        <label class="field">Fuente
          <select id="p_font">${FONTS.map(f=>`<option value="${f}" ${f===sel.fontFamily?'selected':''}>${f}</option>`).join('')}</select>
        </label>
        <div class="row">
          <label class="field">Tamaño<input type="number" id="p_size" value="${sel.fontSize}" min="6"></label>
          <label class="field">Alineación
            <select id="p_align">
              <option value="left" ${sel.align==='left'?'selected':''}>Izq.</option>
              <option value="center" ${sel.align==='center'?'selected':''}>Centro</option>
              <option value="right" ${sel.align==='right'?'selected':''}>Der.</option>
            </select>
          </label>
        </div>
        <div class="row" style="margin-bottom:9px">
          <button id="p_bold" class="${sel.bold?'toggled':''}" style="flex:1">Negrita</button>
          <button id="p_italic" class="${sel.italic?'toggled':''}" style="flex:1">Cursiva</button>
        </div>
        <label class="field">Opacidad: <span id="p_opacity_val">${sel.opacity}</span>%
          <input type="range" id="p_opacity" min="0" max="100" value="${sel.opacity}">
        </label>

        <legend>WordArt — estilos rápidos</legend>
        <div class="waRow">
          <button type="button" class="wa-preset small" data-p="arcoiris">🌈 Arcoíris</button>
          <button type="button" class="wa-preset small" data-p="neon">💡 Neón</button>
          <button type="button" class="wa-preset small" data-p="comic">💥 Cómic</button>
          <button type="button" class="wa-preset small" data-p="oro">✨ Oro</button>
          <button type="button" class="wa-preset small" data-p="fuego">🔥 Fuego</button>
          <button type="button" class="wa-preset small" data-p="limpio">◻️ Limpio</button>
        </div>

        <legend>Color de texto</legend>
        <div id="p_color_ctl"></div>

        <div class="toggleRow">
          <button id="p_stroke_toggle" class="small ${sel.strokeEnabled?'toggled':''}">Contorno</button>
          <label class="field">Grosor<input type="number" id="p_strokewidth" value="${sel.strokeWidth}" min="1" max="20"></label>
        </div>
        <div id="p_strokecolor_ctl" style="display:${sel.strokeEnabled?'block':'none'}"></div>

        <div class="toggleRow">
          <button id="p_shadow_toggle" class="small ${sel.shadowEnabled?'toggled':''}">Sombra / brillo</button>
        </div>
        <div id="p_shadow_fields" style="display:${sel.shadowEnabled?'block':'none'}">
          <div class="row">
            <label class="field">Color<input type="color" id="p_shadowcolor" value="${sel.shadowColor}"></label>
            <label class="field">Difuminado<input type="number" id="p_shadowblur" value="${sel.shadowBlur}" min="0" max="60"></label>
          </div>
          <div class="row">
            <label class="field">Desplaz. X<input type="number" id="p_shadowx" value="${sel.shadowOffsetX}"></label>
            <label class="field">Desplaz. Y<input type="number" id="p_shadowy" value="${sel.shadowOffsetY}"></label>
          </div>
        </div>

        <legend>Forma del texto</legend>
        <label class="field">Trazado
          <select id="p_textshape">
            <option value="recta" ${sel.textShape==='recta'?'selected':''}>Recta</option>
            <option value="curva-arriba" ${sel.textShape==='curva-arriba'?'selected':''}>Curva hacia arriba ⌢</option>
            <option value="curva-abajo" ${sel.textShape==='curva-abajo'?'selected':''}>Curva hacia abajo ⌣</option>
          </select>
        </label>
        <label class="field">Intensidad de curva: <span id="p_curve_val">${sel.curveAmount}</span>
          <input type="range" id="p_curve" min="1" max="100" value="${sel.curveAmount}">
        </label>
        <label class="field">Rotación (diagonal): <span id="p_rotation_val">${sel.rotation||0}</span>°
          <input type="range" id="p_rotation" min="-180" max="180" value="${sel.rotation||0}">
        </label>
        <p class="hint">Tip: con dos dedos sobre el lienzo puedes pellizcar para escalar y girar el elemento seleccionado.</p>

        <legend>Forma / fondo de etiqueta</legend>
        <label class="field">Forma
          <select id="p_shape">
            <option value="none" ${sel.bgShape==='none'?'selected':''}>Ninguna</option>
            <option value="rect" ${sel.bgShape==='rect'?'selected':''}>Rectángulo</option>
            <option value="rounded" ${sel.bgShape==='rounded'?'selected':''}>Redondeada</option>
            <option value="circle" ${sel.bgShape==='circle'?'selected':''}>Óvalo</option>
          </select>
        </label>
        <label class="field">Color de fondo</label>
        <div id="p_bgcolor_ctl"></div>
        <label class="field" style="margin-top:9px">Color de borde</label>
        <div id="p_bordercolor_ctl"></div>
        <label class="field" style="margin-top:9px">Grosor borde<input type="number" id="p_borderwidth" value="${sel.borderWidth}" min="0"></label>
      `;
    } else {
      body = `
        <p class="hint">Arrastra el centro para mover; el cuadro azul de la esquina para redimensionar; el círculo de arriba para rotar. También puedes pellizcar con dos dedos.</p>
        <label class="field">Rotación (diagonal): <span id="p_irotation_val">${sel.rotation||0}</span>°
          <input type="range" id="p_irotation" min="-180" max="180" value="${sel.rotation||0}">
        </label>
        <button class="block" id="p_ratio">Restablecer proporción</button>

        <legend>Ajustes</legend>
        <label class="field">Opacidad: <span id="p_iopacity_val">${sel.opacity}</span>%
          <input type="range" id="p_iopacity" min="0" max="100" value="${sel.opacity}">
        </label>
        <label class="field">Brillo: <span id="p_ibrightness_val">${sel.brightness}</span>%
          <input type="range" id="p_ibrightness" min="0" max="200" value="${sel.brightness}">
        </label>
        <label class="field">Contraste: <span id="p_icontrast_val">${sel.contrast}</span>%
          <input type="range" id="p_icontrast" min="0" max="200" value="${sel.contrast}">
        </label>
        <label class="field">Saturación: <span id="p_isaturate_val">${sel.saturate}</span>%
          <input type="range" id="p_isaturate" min="0" max="200" value="${sel.saturate}">
        </label>
        <label class="field">Escala de grises: <span id="p_igray_val">${sel.grayscale}</span>%
          <input type="range" id="p_igray" min="0" max="100" value="${sel.grayscale}">
        </label>
        <label class="field">Sepia: <span id="p_isepia_val">${sel.sepia}</span>%
          <input type="range" id="p_isepia" min="0" max="100" value="${sel.sepia}">
        </label>
        <label class="field">Desenfoque: <span id="p_iblur_val">${sel.blur}</span>px
          <input type="range" id="p_iblur" min="0" max="15" value="${sel.blur}">
        </label>
        <button class="block small" id="p_ireset" style="margin-top:4px">Restablecer ajustes</button>

        <legend>Reflejar</legend>
        <div class="row">
          <button id="p_fliph" class="${sel.flipH?'toggled':''}" style="flex:1">↔ Horizontal</button>
          <button id="p_flipv" class="${sel.flipV?'toggled':''}" style="flex:1">↕ Vertical</button>
        </div>

        <legend>Recorte</legend>
        <label class="field">Forma
          <select id="p_corner">
            <option value="none" ${sel.cornerShape==='none'?'selected':''}>Ninguna</option>
            <option value="rounded" ${sel.cornerShape==='rounded'?'selected':''}>Esquinas redondeadas</option>
            <option value="circle" ${sel.cornerShape==='circle'?'selected':''}>Círculo / óvalo</option>
          </select>
        </label>
      `;
    }
    return `
      <div class="popHead" id="popDragHandle"><span class="popHeadTitle"><span class="popDragDot"></span><span class="popTitleText">${title}</span></span><button class="popClose" id="p_close">✕</button></div>
      ${body}
      <div style="height:10px"></div>
      <button class="danger block" id="p_delete">Eliminar este elemento</button>
    `;
  }
  function wirePopover(sel){
    document.getElementById('p_close').addEventListener('click', closePopover);
    document.getElementById('p_delete').addEventListener('click', deleteSelected);
    if(sel.type==='text'){
      byId('p_autosize').addEventListener('change', e=>{
        sel.autoSize = e.target.checked;
        if(sel.autoSize) computeAutoSize(sel);
        render();
      });
      byId('p_content').addEventListener('input', e=>{ sel.content=e.target.value; render(); });
      const contentTa = byId('p_content');
      function applyRich(prop, forcedValue){
        const hasSel = contentTa.selectionStart !== contentTa.selectionEnd;
        const start = contentTa.selectionStart, end = contentTa.selectionEnd;
        if(!hasSel && (prop==='bold' || prop==='italic')){
          sel[prop] = forcedValue!=null ? forcedValue : !sel[prop];
          render();
          return;
        }
        const s = hasSel ? start : 0;
        const e = hasSel ? end : sel.content.length;
        sel.richRanges = sel.richRanges || [];
        const value = forcedValue!=null ? forcedValue : !styleAt(sel,s)[prop];
        sel.richRanges.push({ start:s, end:e, [prop]: value });
        render();
        contentTa.focus(); if(hasSel) contentTa.setSelectionRange(start,end);
      }
      byId('p_rich_bold').addEventListener('click', ()=> applyRich('bold'));
      byId('p_rich_italic').addEventListener('click', ()=> applyRich('italic'));
      byId('p_rich_underline').addEventListener('click', ()=> applyRich('underline'));
      byId('p_rich_strike').addEventListener('click', ()=> applyRich('strike'));
      byId('p_rich_clear').addEventListener('click', ()=>{
        const hasSel = contentTa.selectionStart !== contentTa.selectionEnd;
        const start = contentTa.selectionStart, end = contentTa.selectionEnd;
        sel.richRanges = sel.richRanges || [];
        if(!hasSel){
          sel.richRanges = [];
          sel.bold = false; sel.italic = false;
        } else {
          sel.richRanges.push({start, end, bold:false, italic:false, underline:false, strike:false});
        }
        render();
        contentTa.focus(); if(hasSel) contentTa.setSelectionRange(start,end);
      });
      byId('p_font').addEventListener('change', e=>{ sel.fontFamily=e.target.value; render(); });
      byId('p_size').addEventListener('input', e=>{ sel.fontSize=parseInt(e.target.value)||12; render(); });
      byId('p_align').addEventListener('change', e=>{ sel.align=e.target.value; render(); });
      byId('p_bold').addEventListener('click', e=>{ sel.bold=!sel.bold; e.target.classList.toggle('toggled'); render(); });
      byId('p_italic').addEventListener('click', e=>{ sel.italic=!sel.italic; e.target.classList.toggle('toggled'); render(); });
      byId('p_opacity').addEventListener('input', e=>{ sel.opacity=parseInt(e.target.value); byId('p_opacity_val').textContent=sel.opacity; render(); });
      document.querySelectorAll('.wa-preset').forEach(btn=>{
        btn.addEventListener('click', ()=>{ WORDART_PRESETS[btn.dataset.p](sel); render(); refreshPopoverInPlace(sel); });
      });
      byId('p_stroke_toggle').addEventListener('click', e=>{
        sel.strokeEnabled=!sel.strokeEnabled; e.target.classList.toggle('toggled');
        byId('p_strokecolor_ctl').style.display = sel.strokeEnabled?'block':'none';
        render();
      });
      byId('p_strokewidth').addEventListener('input', e=>{ sel.strokeWidth=parseFloat(e.target.value)||1; render(); });
      byId('p_shadow_toggle').addEventListener('click', e=>{
        sel.shadowEnabled=!sel.shadowEnabled; e.target.classList.toggle('toggled');
        byId('p_shadow_fields').style.display = sel.shadowEnabled?'block':'none';
        render();
      });
      byId('p_shadowcolor').addEventListener('input', e=>{ sel.shadowColor=e.target.value; render(); });
      byId('p_shadowblur').addEventListener('input', e=>{ sel.shadowBlur=parseInt(e.target.value)||0; render(); });
      byId('p_shadowx').addEventListener('input', e=>{ sel.shadowOffsetX=parseInt(e.target.value)||0; render(); });
      byId('p_shadowy').addEventListener('input', e=>{ sel.shadowOffsetY=parseInt(e.target.value)||0; render(); });
      byId('p_textshape').addEventListener('change', e=>{ sel.textShape=e.target.value; render(); });
      byId('p_curve').addEventListener('input', e=>{ sel.curveAmount=parseInt(e.target.value); byId('p_curve_val').textContent=sel.curveAmount; render(); });
      byId('p_rotation').addEventListener('input', e=>{ sel.rotation=parseInt(e.target.value); byId('p_rotation_val').textContent=sel.rotation; render(); });
      byId('p_shape').addEventListener('change', e=>{ sel.bgShape=e.target.value; render(); });
      byId('p_borderwidth').addEventListener('input', e=>{ sel.borderWidth=parseInt(e.target.value)||0; render(); });
      initColorControl(byId('p_color_ctl'), sel.color, v=>{ sel.color=v; render(); });
      initColorControl(byId('p_strokecolor_ctl'), sel.strokeColor, v=>{ sel.strokeColor=v; render(); });
      initColorControl(byId('p_bgcolor_ctl'), sel.bgColor, v=>{ sel.bgColor=v; render(); });
      initColorControl(byId('p_bordercolor_ctl'), sel.borderColor, v=>{ sel.borderColor=v; render(); });
    } else {
      byId('p_irotation').addEventListener('input', e=>{ sel.rotation=parseInt(e.target.value); byId('p_irotation_val').textContent=sel.rotation; render(); });
      byId('p_ratio').addEventListener('click', ()=>{ const ratio=sel.naturalW/sel.naturalH; sel.h=sel.w/ratio; render(); });
      byId('p_iopacity').addEventListener('input', e=>{ sel.opacity=parseInt(e.target.value); byId('p_iopacity_val').textContent=sel.opacity; render(); });
      byId('p_ibrightness').addEventListener('input', e=>{ sel.brightness=parseInt(e.target.value); byId('p_ibrightness_val').textContent=sel.brightness; render(); });
      byId('p_icontrast').addEventListener('input', e=>{ sel.contrast=parseInt(e.target.value); byId('p_icontrast_val').textContent=sel.contrast; render(); });
      byId('p_isaturate').addEventListener('input', e=>{ sel.saturate=parseInt(e.target.value); byId('p_isaturate_val').textContent=sel.saturate; render(); });
      byId('p_igray').addEventListener('input', e=>{ sel.grayscale=parseInt(e.target.value); byId('p_igray_val').textContent=sel.grayscale; render(); });
      byId('p_isepia').addEventListener('input', e=>{ sel.sepia=parseInt(e.target.value); byId('p_isepia_val').textContent=sel.sepia; render(); });
      byId('p_iblur').addEventListener('input', e=>{ sel.blur=parseInt(e.target.value); byId('p_iblur_val').textContent=sel.blur; render(); });
      byId('p_ireset').addEventListener('click', ()=>{
        sel.opacity=100; sel.brightness=100; sel.contrast=100; sel.saturate=100; sel.grayscale=0; sel.sepia=0; sel.blur=0;
        render(); refreshPopoverInPlace(sel);
      });
      byId('p_fliph').addEventListener('click', e=>{ sel.flipH=!sel.flipH; e.target.classList.toggle('toggled'); render(); });
      byId('p_flipv').addEventListener('click', e=>{ sel.flipV=!sel.flipV; e.target.classList.toggle('toggled'); render(); });
      byId('p_corner').addEventListener('change', e=>{ sel.cornerShape=e.target.value; render(); });
    }
  }
  function byId(id){ return document.getElementById(id); }
  function escapeHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  window.addEventListener('beforeunload', e=>{
    if(objects.length>0){ e.preventDefault(); e.returnValue=''; }
  });

  render();
})();

