const byId = id => document.getElementById(id);
const request = byId("request");
const manuscript = byId("manuscript");
const chat = byId("chat");
const scroll = byId("chat-scroll");
const documentScroll = byId("document-scroll");
const pageStack = byId("paper-pages");
let sheets = [], observer;
let imageUpload = false, thumbnailRun = 0;
let inlineDraft, closePending = false;
let api, state, busy = false, polling = false;
let autosaving = false, composingManuscript = false;
const autosaveInterval = 120_000;
let closing = false;
let mode = "polish", tab = "current", page = 0, total = 0, zoom = 1;
const minimumZoom = .5, maximumZoom = 2.5, zoomStep = .25;
let zoomRenderTimer;
let pageRun = 0, renderedKey = "", chatKey = "", outlineKey = "";
const workspace = document.querySelector(".workspace");
const panes = [
  {pane: byId("outline-pane"), splitter: byId("outline-splitter"), key: "--outline-width", minimum: 150, direction: 1},
  {pane: byId("preview-pane"), splitter: byId("preview-splitter"), key: "--preview-width", minimum: 245, direction: -1},
];
const chatMinimum = 300;

function setPaneWidth(side, requested) {
  const maximum = Math.max(side.minimum,
    side.pane.offsetWidth + workspace.offsetWidth - chatMinimum);
  const width = Math.round(Math.min(maximum, Math.max(side.minimum, requested)));
  document.body.style.setProperty(side.key, width + "px");
  side.splitter.setAttribute("aria-valuemin", side.minimum);
  side.splitter.setAttribute("aria-valuemax", maximum);
  side.splitter.setAttribute("aria-valuenow", width);
}

for (const side of panes) {
  let drag, resizeFrame = 0;
  function applyDrag() {
    resizeFrame = 0;
    if (drag) setPaneWidth(side, drag.width + (drag.latestX - drag.x) * side.direction);
  }
  function stopDrag() {
    if (!drag) return;
    if (resizeFrame) {
      cancelAnimationFrame(resizeFrame);
      applyDrag();
    }
    drag = null;
    side.splitter.classList.remove("dragging");
    document.body.classList.remove("resizing");
    fitColumns();
  }
  side.splitter.onpointerdown = event => {
    if (event.button !== 0) return;
    drag = {id: event.pointerId, x: event.clientX, latestX: event.clientX, width: side.pane.offsetWidth};
    side.splitter.setPointerCapture(event.pointerId);
    side.splitter.classList.add("dragging");
    document.body.classList.add("resizing");
    event.preventDefault();
  };
  side.splitter.onpointermove = event => {
    if (drag?.id === event.pointerId) {
      drag.latestX = event.clientX;
      if (!resizeFrame) resizeFrame = requestAnimationFrame(applyDrag);
    }
  };
  side.splitter.onpointerup = stopDrag;
  side.splitter.onpointercancel = stopDrag;
  side.splitter.onlostpointercapture = stopDrag;
  side.splitter.onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 18 : -18;
    setPaneWidth(side, side.pane.offsetWidth + step * side.direction);
  };
  side.splitter.ondblclick = () => {
    document.body.style.removeProperty(side.key);
    fitColumns();
  };
}

function fitColumns() {
  for (const side of [...panes].reverse()) {
    if (!side.pane.hidden && workspace.offsetWidth < chatMinimum) {
      setPaneWidth(side, side.pane.offsetWidth);
    }
  }
  for (const side of panes) {
    if (side.pane.hidden) continue;
    side.splitter.setAttribute("aria-valuemin", side.minimum);
    side.splitter.setAttribute("aria-valuemax", Math.max(side.minimum,
      side.pane.offsetWidth + workspace.offsetWidth - chatMinimum));
    side.splitter.setAttribute("aria-valuenow", side.pane.offsetWidth);
  }
}
window.addEventListener("resize", fitColumns);
fitColumns();

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render(next, submitted) {
  const previous = state;
  const changed = previous?.id !== next.id;
  state = next;
  if (request.value !== next.request && (changed ||
      (request.value === (submitted?.request ?? previous?.request) &&
       !(autosaving && document.activeElement === request)))) request.value = next.request;
  if (manuscript.value !== next.body && (changed ||
      (manuscript.value === (submitted?.body ?? previous?.body) && !composingManuscript &&
       !(autosaving && document.activeElement === manuscript)))) manuscript.value = next.body;
  if (changed) {
    page = 0;
    if (hasChapter(next)) tab = "chapter";
    else if (tab === "chapter") tab = "current";
  } else if (tab === "chapter" && !hasChapter(next)) tab = "current";
  byId("breadcrumb").textContent = next.id ? [next.project, next.title].join(" / ") : "稿页";
  byId("feedback").textContent = next.feedback || next.notice;
  byId("reading-status").textContent = next.reading || "";
  byId("reading-status").title = next.reading || "";
  byId("image-reference").textContent = next.imageReference ? "参考图已上传" : "参考图";
  if (changed || previous?.imageReference !== next.imageReference) updateReference();
  renderOutline();
  renderChat(changed);
  controls();
  if (tab !== "edit" && !byId("preview-pane").hidden) loadPage();
}

const outline = byId("outline"), outlineMenu = byId("outline-menu");
const collapsedOutline = new Set();
let outlineTarget;

function hasChapter(data) {
  return Boolean(data?.id && data.outline.find(item => item.id === data.id)?.branch);
}

function renderOutline() {
  const signature = JSON.stringify(state.outline.map(({id, label, depth, branch}) => [id, label, depth, branch]));
  if (signature !== outlineKey) {
    outlineKey = signature;
    closeOutlineMenu();
    const parents = [outline];
    outline.replaceChildren();
    for (const item of state.outline) {
      parents.length = item.depth + 1;
      const parent = parents.at(-1);
      if (!item.id) {
        parent.append(element("div", item.label, "project outline-row"));
        parents.push(parent);
        continue;
      }
      const row = element("div", "", "outline-entry");
      row.dataset.sectionId = item.id;
      row.style.setProperty("--outline-depth", Math.min(item.depth, 5));
      const button = element("button", item.label, "outline-row");
      button.title = item.label + "\n双击修改标题，右键打开菜单";
      button.onclick = () => {
        if (busy) return;
        const pane = byId("preview-pane");
        if (pane.hidden) byId("preview-toggle").click();
        if (state.id !== item.id) action("select", {target: item.id});
        else if (item.branch && tab !== "chapter") document.querySelector('[data-tab="chapter"]').click();
      };
      button.ondblclick = () => editOutlineTitle(row, item);
      button.oncontextmenu = event => {
        event.preventDefault();
        openOutlineMenu(row, item, event.clientX, event.clientY);
      };
      button.onkeydown = event => {
        if (event.key === "F2") {
          event.preventDefault();
          editOutlineTitle(row, item);
        } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const bounds = button.getBoundingClientRect();
          openOutlineMenu(row, item, bounds.left, bounds.bottom);
        }
      };
      const finalize = element("button", "✓", "outline-finalize");
      finalize.type = "button";
      finalize.setAttribute("aria-label", item.label + "：已定稿");
      finalize.onclick = () => toggleFinalized(row);
      row.append(button, finalize);
      parent.append(row);
      if (item.branch) {
        const children = element("div", "", "outline-children");
        children.id = `outline-children-${item.id}`;
        const toggle = element("button", "", "outline-disclosure");
        toggle.type = "button";
        toggle.setAttribute("aria-controls", children.id);
        const update = () => {
          children.hidden = collapsedOutline.has(item.id);
          const label = (children.hidden ? "展开「" : "收起「") + item.label + "」";
          toggle.setAttribute("aria-expanded", !children.hidden);
          toggle.setAttribute("aria-label", label);
          toggle.title = label;
        };
        toggle.onclick = () => {
          if (collapsedOutline.has(item.id)) collapsedOutline.delete(item.id);
          else collapsedOutline.add(item.id);
          update();
        };
        row.append(toggle);
        parent.append(children);
        parents.push(children);
        update();
      }
    }
  }
  const finalized = new Set(state.outline.filter(item => item.finalized).map(item => item.id));
  for (const row of outline.querySelectorAll(".outline-entry")) {
    const id = row.dataset.sectionId;
    row.firstElementChild.setAttribute("aria-current", id === state.id);
    const button = row.querySelector(".outline-finalize");
    button.setAttribute("aria-pressed", finalized.has(id));
    button.title = finalized.has(id) ? "已定稿，点击取消" : "标为已定稿";
  }
}

function toggleFinalized(row) {
  const button = row.querySelector(".outline-finalize");
  return action("set_finalized", {target: row.dataset.sectionId,
    finalized: button.getAttribute("aria-pressed") !== "true"});
}

function editOutlineTitle(row, item) {
  if (row.querySelector("input")) return;
  const button = row.firstElementChild;
  const input = element("input", "", "outline-title-input");
  input.value = item.label;
  input.setAttribute("aria-label", "小节标题");
  const finish = (save, restoreFocus) => {
    const title = input.value.trim();
    input.onblur = null;
    input.remove();
    button.hidden = false;
    if (restoreFocus) button.focus();
    if (save && title && title !== item.label) action("rename", {target: item.id, title});
  };
  input.onblur = () => finish(false, false);
  input.onkeydown = event => {
    if (event.isComposing || !["Enter", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Enter" && busy) return;
    if (event.key === "Enter" && !input.value.trim()) {
      input.setCustomValidity("小节标题不能为空。");
      input.reportValidity();
      return;
    }
    finish(event.key === "Enter", true);
  };
  input.oninput = () => input.setCustomValidity("");
  button.hidden = true;
  row.append(input);
  input.focus();
  input.select();
}

function openOutlineMenu(row, item, x, y) {
  outlineTarget = {row, item};
  byId("outline-finalize").textContent = row.querySelector(".outline-finalize").getAttribute("aria-pressed") === "true"
    ? "取消定稿标记" : "标为已定稿";
  outlineMenu.hidden = false;
  outlineMenu.style.left = Math.max(0, Math.min(x, innerWidth - outlineMenu.offsetWidth)) + "px";
  outlineMenu.style.top = Math.max(0, Math.min(y, innerHeight - outlineMenu.offsetHeight)) + "px";
  byId("outline-rename").focus();
}

byId("outline-finalize").onclick = () => {
  const row = outlineTarget?.row;
  closeOutlineMenu();
  if (row) {
    row.querySelector(".outline-finalize").focus();
    toggleFinalized(row);
  }
};

function closeOutlineMenu() {
  outlineMenu.hidden = true;
  outlineTarget = null;
}

document.addEventListener("pointerdown", event => {
  if (!outlineMenu.contains(event.target)) closeOutlineMenu();
});
outline.addEventListener("scroll", closeOutlineMenu, {passive: true});
window.addEventListener("resize", closeOutlineMenu);
outlineMenu.onkeydown = event => {
  if (event.key !== "Escape") return;
  const row = outlineTarget?.row;
  closeOutlineMenu();
  row?.firstElementChild.focus();
};
byId("outline-rename").onclick = () => {
  const target = outlineTarget;
  closeOutlineMenu();
  if (target) editOutlineTitle(target.row, target.item);
};

function appendManuscript(parent, text) {
  let paragraph;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      paragraph = null;
      continue;
    }
    const heading = line.match(/^[ \t]{0,3}([#＃]{1,6})[^\S\n]+(.+?)\s*$/);
    const content = heading ? heading[2].replace(/\s+[#＃]+$/, "") : line;
    const block = heading ? element("h" + heading[1].length, "", "manuscript-heading")
      : paragraph || element("p", "", "manuscript-paragraph");
    if (!block.parentNode) parent.append(block);
    if (block === paragraph) block.append("\n");
    let start = 0;
    for (const match of content.matchAll(/\*\*([^*\n]+)\*\*|(?<![\p{L}\p{N}_])__([^_\n]+)__(?![\p{L}\p{N}_])/gu)) {
      block.append(content.slice(start, match.index), element("strong", match[1] ?? match[2]));
      start = match.index + match[0].length;
    }
    block.append(content.slice(start));
    paragraph = heading ? null : block;
  }
}

function renderChat(changed) {
  const signature = JSON.stringify([state.id, state.rows, state.resultPictures]);
  if (signature === chatKey) return;
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 55;
  const newTurn = chat.childElementCount !== state.rows.length;
  chatKey = signature;
  chat.replaceChildren();
  if (!state.rows.length) {
    chat.append(element("p", state.id ? "在下方输入对这个小节的修改要求。" : "导入 Word 或新建小节后，可以开始逐节修改。", "empty"));
  }
  state.rows.forEach((row, index) => {
    const turn = element("article", "", "turn");
    const user = element("div", "", "user");
    user.append(element("div", row.request, "bubble"));
    const answer = element("div", "", "answer");
    answer.append(element("p", row.status + (row.adopted ? " · 已采用" : ""), "status"));
    appendManuscript(answer, row.body);
    if (row.detail && row.detail !== row.status) answer.append(element("p", row.detail, "status"));
    if (index === state.rows.length - 1) {
      const actions = element("div", "", "turn-actions");
      if (row.retryable) {
        const retry = element("button", "重试本轮");
        retry.onclick = () => action("retry_revision", {revision: row.id});
        actions.append(retry);
      }
      if ((row.body && !row.adopted) || state.resultPictures?.length) {
        const adopt = element("button", "审阅修改");
        adopt.onclick = () => openAdoptionReview(row);
        actions.append(adopt);
      }
      const results = element("button", "查看本轮成果");
      results.onclick = () => openResults(row.id);
      actions.append(results);
      answer.append(actions);
    }
    turn.append(user, answer);
    chat.append(turn);
  });
  if (changed || nearBottom || newTurn) scroll.scrollTop = scroll.scrollHeight;
}

function controls() {
  const active = Boolean(state?.id);
  const disabled = busy || !active;
  document.querySelectorAll("[data-section]").forEach(button => button.disabled = disabled);
  request.readOnly = manuscript.readOnly = !active || (busy && !autosaving);
  byId("section-confirm").disabled = busy;
  byId("read-project-confirm").disabled = disabled;
  byId("save").disabled = disabled || (!state.dirty && manuscript.value === state.body);
  byId("undo").disabled = disabled || (!state.undo && !state.dirty && manuscript.value === state.body && !inlineDraft?.changed());
  byId("prompt").disabled = disabled || state.prompting;
  byId("prompt").lastChild.textContent = state?.prompting ? "正在整理…" : "自动编辑提示词";
  byId("send").disabled = disabled || imageUpload || !state.send;
  byId("send").setAttribute("aria-label", state?.sendLabel || "发送");
  byId("send").title = (state?.sendLabel || "发送") + " · Ctrl + Enter";
  document.querySelectorAll("[data-tab]").forEach(button => {
    if (button.dataset.tab === "chapter") button.hidden = !hasChapter(state);
    button.setAttribute("aria-pressed", button.dataset.tab === tab);
  });
  manuscript.hidden = tab !== "edit";
  byId("manuscript-tools").hidden = tab !== "edit" || !active;
  byId("insert-figure").disabled = disabled;
  byId("document-scroll").hidden = byId("page-tools").hidden = tab === "edit";
}

function inputs() {
  return {id: state?.id, request: request.value, body: manuscript.value, mode,
    writer: byId("paragraph-writer").value};
}

async function action(name, extra = {}) {
  if (!api || busy || (name === "send" && imageUpload)) return;
  if (name === "autosave" && (inlineDraft || composingManuscript)) return;
  if (name === "undo" && inlineDraft?.changed()) {
    discardInline();
    controls();
    return;
  }
  commitInline();
  autosaving = name === "autosave";
  busy = true;
  controls();
  const data = {...inputs(), ...extra};
  if (name === "adopt") byId("feedback").textContent = "正在对照正文与回稿…";
  try {
    const next = await api.action(name, data);
    if (["save", "adopt", "undo"].includes(name)) renderedKey = "";
    render(next, data);
  } catch (error) {
    byId("feedback").textContent = error.message || String(error);
  } finally {
    busy = autosaving = false;
    controls();
    if (closePending) window.closeWorkspace();
  }
}

async function poll() {
  if (!api || busy || polling) return;
  polling = true;
  try {
    const previous = state;
    const next = await api.state();
    if (!busy && previous === state) render(next);
  } catch (error) {
    byId("feedback").textContent = error.message || String(error);
  } finally {
    polling = false;
  }
}

function updateCurrentPage() {
  if (!sheets.length) return;
  const bounds = documentScroll.getBoundingClientRect();
  const center = bounds.top + bounds.height * .4;
  let first = 0, last = sheets.length - 1;
  while (first < last) {
    const middle = (first + last) >> 1;
    if (sheets[middle].node.getBoundingClientRect().bottom > center) last = middle;
    else first = middle + 1;
  }
  page = first;
  const label = (page + 1) + " / " + total;
  if (byId("page-count").textContent === label) return;
  byId("page-count").textContent = label;
  setPageControls(true);
}

let scrollFrame = 0;
documentScroll.addEventListener("scroll", () => {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    updateCurrentPage();
  });
}, {passive: true});

function buildSheet(index, size) {
  const node = element("div", "", "paper-sheet");
  node.style.aspectRatio = size[0] + " / " + size[1];
  node.style.width = Math.round(zoom * 100) + "%";
  node.setAttribute("aria-label", "第 " + (index + 1) + " 页");
  const image = element("img", "");
  image.alt = "Word 第 " + (index + 1) + " 页";
  image.draggable = false;
  image.decoding = "async";
  image.hidden = true;
  const editor = element("div", "", "paper-edit-layer");
  node.append(image, editor);
  return {index, node, image, editor, data: null};
}

function fillSheet(sheet, result) {
  sheet.data = result;
  sheet.image.src = result.src;
  sheet.image.hidden = false;
  renderInline(sheet);
}

function previewPixels() {
  const viewport = documentScroll.clientWidth - 22;
  const width = Math.ceil(zoom * Math.max(900, viewport * Math.max(2.3, devicePixelRatio * 1.65)));
  return Math.max(900, Math.min(3200, width));
}

async function loadVisibleSheet(sheet, run, section, chapter, pixels = previewPixels()) {
  if (sheet.pixels >= pixels || sheet.retry) return;
  if (sheet.loading) {
    sheet.pendingPixels = pixels;
    return;
  }
  sheet.loading = true;
  try {
    const result = await api.page(section, sheet.index, pixels, chapter);
    if (run !== pageRun || result?.number !== sheet.index) return;
    sheet.pixels = pixels;
    if (sheet.data) sheet.image.src = result.src;
    else fillSheet(sheet, result);
  } catch (error) {
    if (run !== pageRun || sheet.data) return;
    const retry = element("button", "第 " + (sheet.index + 1) + " 页加载失败，点击重试", "page-load-retry");
    retry.title = error.message || String(error);
    sheet.retry = retry;
    retry.onclick = () => {
      retry.remove();
      sheet.retry = null;
      loadVisibleSheet(sheet, run, section, chapter);
    };
    sheet.node.append(retry);
  } finally {
    sheet.loading = false;
    const pending = sheet.pendingPixels;
    sheet.pendingPixels = null;
    if (run === pageRun && pending > pixels) loadVisibleSheet(sheet, run, section, chapter, pending);
  }
}

async function loadPage() {
  if (inlineDraft) return;
  const section = state?.id;
  const chapter = tab === "chapter";
  const signature = JSON.stringify([section, chapter, state?.title, state?.body, state?.figures,
    state?.pictureEdits, chapter ? outlineKey : null]);
  if (signature === renderedKey) return;
  renderedKey = signature;
  const target = page;
  const run = ++pageRun;
  clearTimeout(zoomRenderTimer);
  observer?.disconnect();
  inlineDraft = null;
  sheets = [];
  pageStack.replaceChildren();
  byId("retry").hidden = true;
  setPageControls(false);
  byId("page-count").textContent = "—";
  const status = byId("page-status");
  status.hidden = false;
  status.textContent = section ? (chapter ? "正在排版整节…" : "正在用 Word 排版…") : "选择一个小节";
  if (!section) return;
  try {
    const pixels = previewPixels();
    const result = await api.page(section, 0, pixels, chapter);
    if (run !== pageRun || tab === "edit" || !result) return;
    total = result.total;
    sheets = result.sizes.map((size, index) => buildSheet(index, size));
    pageStack.replaceChildren(...sheets.map(sheet => sheet.node));
    fillSheet(sheets[0], result);
    sheets[0].pixels = pixels;
    status.hidden = true;
    goToPage(Math.min(target, total - 1));
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting || run !== pageRun) continue;
        const sheet = sheets[Number(entry.target.dataset.page)];
        loadVisibleSheet(sheet, run, section, chapter);
      }
    }, {root: documentScroll, rootMargin: "550px 0px"});
    for (const sheet of sheets) {
      sheet.node.dataset.page = sheet.index;
      observer.observe(sheet.node);
    }
  } catch (error) {
    if (run !== pageRun) return;
    status.textContent = error.message || String(error);
    byId("retry").hidden = false;
  }
}

function goToPage(index) {
  const sheet = sheets[index];
  if (!sheet) return;
  const top = sheet.node.getBoundingClientRect().top - documentScroll.getBoundingClientRect().top;
  documentScroll.scrollTop += top - 11;
  updateCurrentPage();
  page = index;
  byId("page-count").textContent = (page + 1) + " / " + total;
  setPageControls(true);
}
const pictureDialog = byId("pictures-dialog");
const replacementFile = byId("replacement-file");
let pictureSection, chosenPicture, pictureBusy = false;

async function renderPictures() {
  const pictures = await api.section_pictures(pictureSection);
  byId("picture-status").textContent = pictures.length
    ? "有多张原图时，请在对应条目点「用本轮生成图」或「用本轮文献图」，也可以拖入或粘贴图片。"
    : "本节没有图片。可在「编辑正文」里插入图位。";
  byId("picture-list").replaceChildren(...pictures.map((picture, index) => {
    const row = element("div", "", "picture-row");
    row.tabIndex = 0;
    row.dataset.pictureId = picture.id;
    row.onpointerdown = event => { if (!event.target.closest("button")) row.focus(); };
    row.ondragover = event => { event.preventDefault(); row.classList.add("drop-active"); };
    row.ondragleave = event => { if (!row.contains(event.relatedTarget)) row.classList.remove("drop-active"); };
    row.ondrop = event => {
      event.preventDefault();
      row.classList.remove("drop-active");
      const file = [...event.dataTransfer.files].find(isImageFile);
      if (file) replacePicture(picture.id, file, null);
    };
    row.onpaste = event => {
      const file = clipboardImage(event.clipboardData);
      if (file) { event.preventDefault(); replacePicture(picture.id, file, null); }
    };
    if (picture.src) {
      const image = element("img", "");
      image.src = picture.src;
      image.alt = "原稿图片 " + (index + 1);
      row.append(image);
    }
    row.append(element("strong", picture.slot ? (picture.replaced ? "已填图位" : "待填图位")
      : "原图 " + (index + 1) + (picture.replaced || picture.automatic ? " · 已替换" : "")));
    function button(label, callback) {
      const control = element("button", label);
      control.type = "button";
      control.onclick = callback;
      row.append(control);
    }
    button("选本地图片", () => { chosenPicture = picture.id; replacementFile.click(); });
    for (const stage of state.resultPictures || []) {
      button(stage === "figure" ? "用本轮生成图" : "用本轮文献图",
        () => replacePicture(picture.id, null, stage));
    }
    if (picture.replaced) button(picture.slot ? "清空图片" : "恢复原图", () => replacePicture(picture.id, null, null));
    row.append(element("span", "拖入或粘贴", "picture-drop"));
    return row;
  }));
}

async function replacePicture(id, file, stage) {
  if (pictureBusy) return;
  pictureBusy = true;
  try {
    await api.replace_picture(pictureSection, id, file ? await encodeFile(file, 20) : null, stage);
    renderedKey = "";
    await poll();
    await renderPictures();
  } catch (error) { byId("picture-status").textContent = error.message || String(error); }
  finally { pictureBusy = false; }
}
replacementFile.onchange = () => {
  const file = replacementFile.files[0];
  replacementFile.value = "";
  if (file) replacePicture(chosenPicture, file, null);
};
async function openPictures(focusId) {
  if (!state?.id || busy || pictureDialog.open) return;
  pictureSection = state.id;
  try {
    if (manuscript.value !== state.body) await action("sync");
    await renderPictures();
    pictureDialog.showModal();
    [...byId("picture-list").children].find(row => row.dataset.pictureId === focusId)?.focus();
  } catch (error) { byId("feedback").textContent = error.message || String(error); }
}
byId("edit-pictures").onclick = () => openPictures();
byId("insert-figure").onclick = async () => {
  if (!state?.id || busy) return;
  const key = [...crypto.getRandomValues(new Uint8Array(6))].map(n => n.toString(16).padStart(2, "0")).join("");
  const text = manuscript.value;
  const end = text.indexOf("\n", manuscript.selectionEnd);
  const position = end < 0 ? text.length : end;
  const marker = "[[图位:" + key + "]]";
  manuscript.value = text.slice(0, position) + "\n\n" + marker + "\n\n" + text.slice(position).replace(/^\n+/, "");
  await action("save");
  await openPictures("slot:" + key);
};

function renderInline(sheet) {
  sheet.editor.replaceChildren();
  if (tab !== "current" || !sheet.data) return;
  for (const block of sheet.data.paragraphs) {
    const button = element("button", "", "paragraph-hit");
    const [left, top, right, bottom] = block.box;
    Object.assign(button.style, {left: left*100+"%", top: top*100+"%",
      width: (right-left)*100+"%", height: (bottom-top)*100+"%"});
    button.title = "编辑此段";
    button.setAttribute("aria-label", "编辑段落：" + block.text.slice(0, 32));
    button.onclick = () => openInline(sheet, block);
    sheet.editor.append(button);
  }
}
function openInline(sheet, block) {
  const previewBody = sheet.data.body;
  if (inlineDraft?.changed()) {
    action("save");
    return;
  }
  if (busy || manuscript.value.trim() !== previewBody) {
    byId("feedback").textContent = "正文已变更，请切换预览重新排版后再编辑。";
    return;
  }
  discardInline();
  const editor = element("div", "", "page-editor");
  editor.style.left = "5%";
  editor.style.width = "90%";
  editor.style.top = Math.min(block.box[1], .78)*100+"%";
  const input = element("textarea", "");
  input.value = block.text;
  input.setAttribute("aria-label", "编辑此段正文");
  const save = element("button", "保存此段");
  const cancel = element("button", "取消");
  inlineDraft = {sheet, block, input, base: previewBody, changed: () => input.value !== block.text};
  input.oninput = controls;
  cancel.onclick = () => { discardInline(); controls(); };
  save.onclick = () => {
    if (busy) return;
    action("save");
  };
  input.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === "Escape") { discardInline(); controls(); }
    if ((event.ctrlKey && event.key === "Enter") || (event.ctrlKey && event.key.toLowerCase() === "s")) {
      event.preventDefault();
      save.click();
    }
  };
  editor.append(input, cancel, save);
  sheet.editor.replaceChildren(editor);
  input.focus();
}

function discardInline() {
  const sheet = inlineDraft?.sheet;
  inlineDraft = null;
  if (sheet) renderInline(sheet);
}

function commitInline() {
  if (!inlineDraft?.changed()) return;
  const {base, block, input} = inlineDraft;
  if (manuscript.value.trim() !== base) return;
  manuscript.value = base.slice(0, block.start) + input.value.trim() + base.slice(block.end);
  discardInline();
}

async function encodeFile(file, maxMB) {
  if (file.size > maxMB * 1024 * 1024) throw new Error("文件不能超过 " + maxMB + " MB。");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("无法读取文件。"));
    reader.readAsDataURL(file);
  });
}
const imageFile = byId("image-file");
const composer = byId("composer");
const referenceDrop = byId("reference-drop");
function showReferenceZone() {
  referenceDrop.hidden = mode !== "illustrate" && !state?.imageReference;
}
async function updateReference() {
  const run = ++thumbnailRun, section = state?.id, attached = state?.imageReference;
  const preview = byId("reference-thumbnail");
  preview.hidden = true;
  byId("reference-remove").hidden = !attached;
  byId("reference-label").textContent = attached ? "参考图已上传 · 可拖入或粘贴替换" : "参考图 · 拖入或粘贴图片";
  showReferenceZone();
  if (attached) {
    try {
      const src = await api.reference_thumbnail(section);
      if (run !== thumbnailRun || !src) return;
      preview.src = src;
      preview.hidden = false;
    } catch (error) { byId("feedback").textContent = error.message || String(error); }
  }
}
async function uploadReference(file) {
  const section = state?.id;
  if (!section || busy || imageUpload) return;
  imageUpload = true;
  controls();
  try {
    await api.reference_image(section, file ? await encodeFile(file, 15) : null);
    if (state?.id === section) {
      state.imageReference = Boolean(file);
      byId("image-reference").textContent = file ? "参考图已上传" : "参考图";
      await updateReference();
    }
    byId("feedback").textContent = file ? "参考图已保存，提交「优化并出图」时会随任务发送。" : "已移除参考图。";
  } catch (error) { byId("feedback").textContent = error.message || String(error); }
  finally { imageUpload = false; controls(); }
}
byId("reference-pick").onclick = byId("image-reference").onclick = () => imageFile.click();
byId("reference-remove").onclick = () => uploadReference(null);
imageFile.onchange = () => {
  const file = imageFile.files[0];
  imageFile.value = "";
  if (file) uploadReference(file);
};
composer.ondragover = event => {
  if (event.dataTransfer.types.includes("Files")) {
    event.preventDefault();
    composer.classList.add("drop-active");
  }
};
composer.ondragleave = event => {
  if (!composer.contains(event.relatedTarget)) composer.classList.remove("drop-active");
};
composer.ondrop = event => {
  event.preventDefault();
  composer.classList.remove("drop-active");
  const file = [...event.dataTransfer.files].find(item => item.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(item.name));
  if (file) uploadReference(file);
};
function isImageFile(file) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name);
}
function clipboardImage(clipboard) {
  const item = [...(clipboard?.items || [])].find(item => item.type.startsWith("image/"));
  return item?.getAsFile() || [...(clipboard?.files || [])].find(isImageFile);
}
composer.onpaste = event => {
  const file = clipboardImage(event.clipboardData);
  if (!file) return;
  event.preventDefault();
  uploadReference(file);
};

const styleDialog = byId("style-dialog");
const styleText = byId("style-text");
const styleStatus = byId("style-status");
let generatingStyle = false;
byId("open-style").onclick = async () => {
  try {
    if (!generatingStyle) styleText.value = await api.writing_style(null);
    styleDialog.showModal();
  } catch (error) { templateStatus.textContent = error.message || String(error); }
};
byId("style-generate").onclick = async () => {
  const file = byId("style-file").files[0];
  if (!file || generatingStyle) { styleStatus.textContent = "请先选择参考论文。"; return; }
  generatingStyle = true;
  byId("style-generate").disabled = byId("style-apply").disabled = byId("style-clear").disabled = true;
  styleStatus.textContent = "豆包正在提取风格…";
  try {
    styleText.value = await api.generate_style(file.name, await encodeFile(file, 30));
    styleStatus.textContent = "提取完成。可编辑后应用。";
  } catch (error) { styleStatus.textContent = error.message || String(error); }
  finally {
    generatingStyle = false;
    byId("style-generate").disabled = byId("style-apply").disabled = byId("style-clear").disabled = false;
  }
};
async function applyStyle(clear) {
  try {
    if (!clear && !styleText.value.trim()) throw new Error("请先填写或生成风格提示词。");
    styleText.value = await api.writing_style(clear ? "" : styleText.value);
    styleStatus.textContent = clear ? "已停用写作风格。" : "已应用到四种模式，下次提交生效。";
  } catch (error) { styleStatus.textContent = error.message || String(error); }
}
byId("style-apply").onclick = () => applyStyle(false);
byId("style-clear").onclick = () => applyStyle(true);

function setPageControls(ready) {
  byId("previous").disabled = !ready || page === 0;
  byId("next").disabled = !ready || page + 1 >= total;
  byId("zoom-out").disabled = !ready || zoom <= minimumZoom;
  byId("zoom-in").disabled = !ready || zoom >= maximumZoom;
  byId("zoom").disabled = !ready || zoom === 1;
  byId("zoom").textContent = zoom === 1 ? "适合宽度" : Math.round(zoom * 100) + "%";
}

const sectionDialog = byId("section-dialog");
let pendingSectionDelete;
byId("outline-delete").onclick = () => {
  const target = outlineTarget;
  closeOutlineMenu();
  if (!target) return;
  pendingSectionDelete = target.item.id;
  sectionDialog.returnValue = "";
  byId("section-dialog-message").textContent = "从大纲移除「" + target.item.label + "」？原文件会留在任务目录。";
  sectionDialog.showModal();
};
byId("section-confirm").onclick = () => {
  const target = pendingSectionDelete;
  if (busy || !target) return;
  sectionDialog.close();
  action("delete", {target});
};

const templateDialog = byId("templates");
const templateMode = byId("template-mode");
const templateText = byId("template-text");
const templateStatus = byId("template-status");
let templates = [], draftTemplates = new Map(), templateKey;

function selectTemplate(key) {
  if (templateKey) draftTemplates.set(templateKey, templateText.value);
  templateKey = key;
  templateText.value = draftTemplates.get(key) ?? templates.find(item => item.id === key).text;
  templateStatus.textContent = "";
}

byId("edit-templates").onclick = async () => {
  if (!api) return;
  try {
    templates = await api.prompts();
    draftTemplates = new Map();
    templateKey = undefined;
    templateMode.replaceChildren(...templates.map(item => {
      const option = element("option", item.label);
      option.value = item.id;
      return option;
    }));
    templateMode.value = mode;
    selectTemplate(mode);
    templateDialog.showModal();
  } catch (error) {
    byId("feedback").textContent = error.message || String(error);
  }
};
templateMode.onchange = () => selectTemplate(templateMode.value);

async function saveTemplate(reset) {
  const save = byId("template-save"), restore = byId("template-reset");
  save.disabled = restore.disabled = templateMode.disabled = templateText.readOnly = true;
  try {
    const text = await api.save_prompt(templateKey, reset ? null : templateText.value);
    templates.find(item => item.id === templateKey).text = text;
    templateText.value = text;
    draftTemplates.set(templateKey, text);
    templateStatus.textContent = reset ? "已恢复默认" : "已保存，下次任务生效";
  } catch (error) {
    templateStatus.textContent = error.message || String(error);
  } finally {
    save.disabled = restore.disabled = templateMode.disabled = templateText.readOnly = false;
  }
}
byId("template-save").onclick = () => saveTemplate(false);
byId("template-reset").onclick = () => saveTemplate(true);

const projectExport = byId("project-export");
const projectSelect = byId("export-project");
const formatRequirements = byId("export-format");
const formatReference = byId("export-reference");
const exportStatus = byId("export-status");
const exportConfirm = byId("export-project-confirm");
let exportRunning = false;
function openProjectExport() {
  if (!api || busy || !state?.outline.length) return;
  let count;
  const options = [];
  for (const row of state.outline) {
    if (!row.id) {
      count = 0;
      options.push(element("option", row.label));
    } else if (options.length) {
      options.at(-1).dataset.count = ++count;
    }
  }
  projectSelect.replaceChildren(...options);
  projectSelect.value = state.project;
  if (projectSelect.selectedIndex < 0) projectSelect.selectedIndex = 0;
  projectSelect.onchange();
  projectExport.returnValue = "";
  exportStatus.textContent = "";
  projectExport.showModal();
}
projectSelect.onchange = () => {
  byId("export-check-results").replaceChildren();
  const count = projectSelect.selectedOptions[0]?.dataset.count || 0;
  byId("export-count").textContent = "将导出该大节下的 " + count + " 个条目。";
};
byId("export-check").onclick = async () => {
  if (exportRunning || !projectSelect.value) return;
  const output = byId("export-check-results");
  const project = projectSelect.value;
  commitInline();
  output.textContent = "正在检查…";
  try {
    const warnings = await api.check_word_export({...inputs(), project});
    if (!projectExport.open || projectSelect.value !== project) return;
    output.replaceChildren(...warnings.map(warning => {
      const button = element("button", warning.title + " · " + warning.detail);
      button.type = "button";
      button.onclick = () => { projectExport.close(); action("select", {target: warning.id}); };
      return button;
    }));
    if (!warnings.length) output.textContent = "未发现空图位、重复图号或核查报告中的待核实事项。";
  } catch (error) { output.textContent = error.message || String(error); }
};
projectExport.addEventListener("cancel", event => { if (exportRunning) event.preventDefault(); });
exportConfirm.onclick = () => exportProject(projectSelect.value);
async function exportProject(project) {
  if (!api || busy || !project) return;
  const requirements = formatRequirements.value.trim();
  const file = formatReference.files[0];
  commitInline();
  busy = exportRunning = true;
  const fields = projectExport.querySelectorAll("button, input, select, textarea");
  fields.forEach(field => field.disabled = true);
  exportStatus.textContent = requirements || file ? "正在解析参考格式…" : "请选择 Word 保存位置。";
  controls();
  try {
    const reference = file ? {name: file.name, data: await encodeFile(file, 30)} : null;
    if (await api.export_word({...inputs(), project, formatRequirements: requirements, formatReference: reference})) {
      projectExport.close();
      byId("feedback").textContent = "已导出「" + project + "」。";
    } else exportStatus.textContent = "已取消保存。";
  } catch (error) {
    exportStatus.textContent = error.message || String(error);
  } finally {
    fields.forEach(field => field.disabled = false);
    busy = exportRunning = false;
    controls();
    if (closePending) window.closeWorkspace();
  }
}

const newPanel = byId("new-panel"), newForm = byId("new-form");
const modelPanel = byId("model-panel"), modelForm = byId("model-form");
const resultsPanel = byId("results-panel"), resultKind = byId("result-picture-kind");
let modelOptions, resultTarget, resultData, resultTab, resultRun = 0;
let resultContentKey, resultStepsKey;

const collaborationPanel = byId("collaboration-panel");
const fullEditPanel = byId("full-edit-panel");
const fullEditInstruction = byId("full-edit-instruction");
const fullEditChanges = byId("full-edit-changes");
const fullEditStatus = byId("full-edit-status");
const fullEditApply = byId("full-edit-apply");
const fullEditAnalyze = byId("full-edit-analyze");
const fullEditClose = byId("full-edit-close");
const fullEditUndo = byId("full-edit-undo");
const includeFinalized = byId("full-edit-include-finalized");
let fullEditToken, fullEditRunning = false;

function clearFullEditPlan() {
  fullEditToken = null;
  fullEditChanges.replaceChildren();
  fullEditApply.disabled = true;
}

function selectedFullEdits() {
  return [...fullEditChanges.querySelectorAll("input:checked")].map(input => Number(input.value));
}

byId("full-edit-open").onclick = () => {
  if (!api || busy || !state?.id) return;
  clearFullEditPlan();
  fullEditInstruction.value = "";
  includeFinalized.checked = false;
  fullEditUndo.hidden = true;
  fullEditUndo.textContent = "撤回最近一批";
  fullEditStatus.textContent = "";
  byId("full-edit-project").textContent = state.project;
  fullEditPanel.showModal();
  fullEditInstruction.focus();
  const project = state.project;
  api.has_full_edit_history(project).then(available => {
    if (fullEditPanel.open && state.project === project) fullEditUndo.hidden = !available;
  }).catch(() => {});
};
fullEditClose.onclick = () => fullEditPanel.close();
fullEditPanel.oncancel = event => { if (fullEditRunning) event.preventDefault(); };
fullEditInstruction.oninput = () => {
  clearFullEditPlan();
  fullEditStatus.textContent = "";
};
includeFinalized.onchange = fullEditInstruction.oninput;
fullEditChanges.onchange = () => {
  fullEditApply.disabled = !fullEditToken || !selectedFullEdits().length;
};

async function runFullEdit(callback) {
  if (!api || busy || !state?.id) return;
  busy = fullEditRunning = true;
  fullEditInstruction.readOnly = true;
  includeFinalized.disabled = fullEditUndo.disabled = true;
  fullEditAnalyze.disabled = fullEditApply.disabled = fullEditClose.disabled = true;
  fullEditChanges.inert = true;
  controls();
  try {
    await callback();
  } catch (error) {
    clearFullEditPlan();
    fullEditStatus.textContent = error.message || String(error);
  } finally {
    busy = fullEditRunning = false;
    fullEditInstruction.readOnly = false;
    includeFinalized.disabled = fullEditUndo.disabled = false;
    fullEditAnalyze.disabled = fullEditClose.disabled = false;
    fullEditChanges.inert = false;
    fullEditChanges.onchange();
    controls();
    if (closePending) window.closeWorkspace();
  }
}

fullEditAnalyze.onclick = () => {
  const instruction = fullEditInstruction.value.trim();
  if (!instruction) {
    fullEditStatus.textContent = "请输入修改要求。";
    fullEditInstruction.focus();
    return;
  }
  runFullEdit(async () => {
    clearFullEditPlan();
    commitInline();
    fullEditStatus.textContent = "正在分批分析正文，长篇论文可能需要几分钟…";
    const result = await api.analyze_full_edit({...inputs(), instruction, includeFinalized: includeFinalized.checked});
    fullEditToken = result.token;
    for (const change of result.changes) {
      const row = element("label", "", "full-edit-change");
      const checkbox = element("input", "");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.value = change.id;
      const detail = element("div", "");
      detail.append(element("strong", change.title), element("span", "原文　" + change.before),
        element("span", "改为　" + change.after));
      row.append(checkbox, detail);
      fullEditChanges.append(row);
    }
    fullEditStatus.textContent = `已检查 ${result.sections} 个小节，找到 ${result.changes.length} 处建议修改。`
      + (result.skipped ? ` 已跳过 ${result.skipped} 个已定稿小节。` : "");
  });
};
fullEditApply.onclick = () => runFullEdit(async () => {
  const selected = selectedFullEdits();
  const submitted = inputs();
  fullEditStatus.textContent = "正在保存修改…";
  const result = await api.apply_full_edit(fullEditToken, selected);
  clearFullEditPlan();
  renderedKey = "";
  render(result.state, submitted);
  byId("feedback").textContent = result.message;
  fullEditStatus.textContent = result.message;
  if (!result.error) fullEditPanel.close();
});
fullEditUndo.onclick = () => {
  if (fullEditUndo.textContent !== "确认撤回") {
    fullEditUndo.textContent = "确认撤回";
    fullEditStatus.textContent = "将恢复最近一批修改前的正文。如果有后续编辑，稿页会提示。";
    return;
  }
  fullEditUndo.textContent = "撤回最近一批";
  runFullEdit(async () => {
    commitInline();
    const submitted = inputs();
    const next = await api.undo_full_edit({...submitted, project: state.project});
    clearFullEditPlan();
    renderedKey = "";
    render(next, submitted);
    fullEditUndo.hidden = true;
    fullEditStatus.textContent = next.feedback;
  });
};

const adoptionPanel = byId("adoption-review");
const adoptionApply = byId("adoption-apply");
const adoptionReplace = byId("adoption-replace");
const adoptionStatus = byId("adoption-status");
const adoptionKind = byId("adoption-image-kind");
const adoptionTarget = byId("adoption-image-target");
let adoptionToken, adoptionRow, adoptionSection, adoptionPictures, adoptionResults, adoptionBusy = false;

function refreshAdoptionPictures() {
  const current = adoptionPictures.find(item => item.id === adoptionTarget.value);
  const result = adoptionResults.find(item => item.pictureKind === adoptionKind.value);
  for (const [id, src] of [["adoption-original", current?.src], ["adoption-new", result?.picture]]) {
    const img = byId(id);
    if (src) img.src = src;
    else img.removeAttribute("src");
    img.hidden = !src;
  }
  const evidence = [result?.source, adoptionResults.find(item => item.tabs.verify)?.tabs.verify].filter(Boolean);
  byId("adoption-evidence").hidden = !evidence.length;
  byId("adoption-source").textContent = [...new Set(evidence)].join("\n\n");
  adoptionReplace.disabled = adoptionBusy || !current || !result?.picture;
}

async function duringAdoption(callback) {
  if (busy || adoptionBusy) return;
  adoptionBusy = busy = true;
  adoptionApply.disabled = adoptionReplace.disabled = true;
  const close = adoptionPanel.querySelector("[data-close]");
  close.disabled = true;
  controls();
  try { await callback(); }
  catch (error) { adoptionStatus.textContent = error.message || String(error); }
  finally {
    adoptionBusy = busy = close.disabled = false;
    adoptionApply.disabled = !adoptionToken;
    refreshAdoptionPictures();
    controls();
    if (closePending) window.closeWorkspace();
  }
}

function openAdoptionReview(row) {
  if (!api || busy || adoptionPanel.open) return;
  adoptionRow = row;
  adoptionSection = state.id;
  adoptionToken = null;
  adoptionPictures = [];
  adoptionResults = [];
  adoptionTarget.replaceChildren();
  adoptionKind.replaceChildren();
  byId("adoption-diff").replaceChildren();
  byId("adoption-pictures").hidden = true;
  byId("adoption-evidence").hidden = true;
  adoptionStatus.textContent = "正在读取本轮成果…";
  adoptionPanel.showModal();
  duringAdoption(async () => {
    commitInline();
    const stages = state.resultPictures ?? [];
    adoptionResults = await Promise.all((stages.length ? stages : ["verify"]).map(stage => api.task_results(row.id, stage)));
    if (stages.length) {
      adoptionPictures = await api.section_pictures(adoptionSection);
      adoptionKind.replaceChildren(...adoptionResults.filter(item => item.picture).map(item => {
        const option = element("option", item.pictureKind === "reference" ? "文献原图" : "生成配图");
        option.value = item.pictureKind;
        return option;
      }));
      adoptionTarget.replaceChildren(...adoptionPictures.map((item, index) => {
        const option = element("option", `${item.slot ? "图位" : "原图"} ${index + 1}`);
        option.value = item.id;
        return option;
      }));
      byId("adoption-pictures").hidden = false;
      byId("adoption-picture-hint").hidden = Boolean(adoptionPictures.length);
    }
    refreshAdoptionPictures();
    if (!row.body || row.adopted) {
      adoptionStatus.textContent = row.adopted ? "本轮正文已采用。" : "最终稿尚未返回。";
      return;
    }
    adoptionStatus.textContent = "正在对照正文与回稿…";
    const result = await api.review_adoption({...inputs(), revision: row.id});
    adoptionToken = result.changes.length ? result.token : null;
    byId("adoption-diff").replaceChildren(...result.changes.map(change => {
      const card = element("div", "", "review-change");
      card.append(element("p", "原文　" + change.before), element("p", "改为　" + change.after));
      return card;
    }));
    adoptionStatus.textContent = result.changes.length ? `找到 ${result.changes.length} 处正文变化。` : "没有可以安全替换的正文。";
  });
}

adoptionPanel.oncancel = event => { if (adoptionBusy) event.preventDefault(); };
adoptionKind.onchange = adoptionTarget.onchange = refreshAdoptionPictures;
adoptionApply.onclick = () => duringAdoption(async () => {
  const token = adoptionToken;
  adoptionToken = null;
  const submitted = inputs();
  renderedKey = "";
  const next = await api.apply_adoption_review(token);
  render(next, submitted);
  adoptionStatus.textContent = next.feedback;
});
adoptionReplace.onclick = () => duringAdoption(async () => {
  await api.replace_picture(adoptionSection, adoptionTarget.value, null, adoptionKind.value, adoptionRow.id);
  adoptionPictures = await api.section_pictures(adoptionSection);
  renderedKey = "";
  render(await api.state());
  adoptionStatus.textContent = "已替换指定图片。";
});
const collaborationApps = ["doubao", "codex"];
let collaborationBusy = false;
let collaborationRefresh = 0;

async function refreshCollaboration() {
  const run = ++collaborationRefresh;
  const data = await api.collaboration();
  if (run !== collaborationRefresh) return;
  byId("collaboration-path").value = data.paths.shared;
  for (const app of collaborationApps) {
    byId(`auto-${app}`).checked = data.auto[app];
    byId(`launch-status-${app}`).textContent = data.status[app] || "";
    const button = collaborationPanel.querySelector(`[data-launch="${app}"]`);
    button.disabled = data.status[app] === "正在打开…";
  }
}

async function collaborationAction(name, value) {
  if (!api || collaborationBusy) return;
  collaborationBusy = true;
  ++collaborationRefresh;
  const status = byId("collaboration-status");
  status.textContent = name === "launch" ? "正在打开…" : "";
  for (const input of collaborationPanel.querySelectorAll("input[type=checkbox]")) input.disabled = true;
  try {
    await api.collaboration_action(name, value);
    await refreshCollaboration();
    status.textContent = {setup:"工作区目录已就绪。", preferences:"已保存。"}[name] || "";
  } catch (error) { status.textContent = error.message || String(error); }
  finally {
    collaborationBusy = false;
    for (const input of collaborationPanel.querySelectorAll("input[type=checkbox]")) input.disabled = false;
  }
}

function updateCollaboration() {
  if (collaborationPanel.open && !collaborationBusy) refreshCollaboration().catch(error => {
    byId("collaboration-status").textContent = error.message || String(error);
  });
}

byId("collaboration-open").onclick = () => {
  if (!api || collaborationPanel.open) return;
  if (!collaborationBusy) byId("collaboration-status").textContent = "";
  collaborationPanel.showModal();
  updateCollaboration();
};
byId("collaboration-path").onclick = event => event.target.select();
byId("collaboration-setup").onclick = () => collaborationAction("setup");
for (const app of collaborationApps) {
  byId(`auto-${app}`).onchange = () => collaborationAction("preferences",
    Object.fromEntries(collaborationApps.map(key => [key,byId(`auto-${key}`).checked])));
}
for (const button of collaborationPanel.querySelectorAll("[data-launch]")) {
  button.onclick = () => collaborationAction("launch", button.dataset.launch);
}
for (const button of collaborationPanel.querySelectorAll("[data-work-folder]")) {
  button.onclick = () => collaborationAction("folder", button.dataset.workFolder);
}

document.querySelectorAll("[data-close]").forEach(button => {
  button.onclick = () => byId(button.dataset.close).close();
});

function openNewSection() {
  if (!api || busy || newPanel.open) return;
  newForm.elements.project.value ||= state?.project || "我的论文";
  byId("new-projects").replaceChildren(...(state?.outline || []).filter(row => !row.id)
    .map(row => element("option", row.label)));
  newPanel.showModal();
}
newForm.elements.provider.onchange = () => {
  const automatic = newForm.elements.provider.value === "agent";
  byId("new-writer").hidden = byId("new-mode").hidden = !automatic;
  byId("new-options").hidden = automatic;
};
byId("new-import").onclick = () => byId("new-file").click();
byId("new-file").onchange = async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const text = await api.import_section_material(file.name, await encodeFile(file, 30));
    newForm.elements.material.value += (newForm.elements.material.value ? "\n\n" : "") + text;
    newForm.elements.title.value ||= file.name.replace(/\.[^.]+$/, "");
    byId("new-status").textContent = "已导入原稿。";
  } catch (error) { byId("new-status").textContent = error.message || String(error); }
};
newForm.onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  commitInline();
  const data = {...inputs(), ...Object.fromEntries(new FormData(newForm))};
  if (event.submitter?.value === "manual") data.provider = "manual";
  busy = true;
  controls();
  try {
    render(await api.new_section(data));
    newForm.reset();
    newForm.elements.provider.onchange();
    byId("new-status").textContent = "";
    newPanel.close();
  } catch (error) { byId("new-status").textContent = error.message || String(error); }
  finally {
    busy = false;
    controls();
    if (closePending) window.closeWorkspace();
  }
};

function syncModelFields(reset) {
  const fields = modelForm.elements;
  const type = fields.provider.value;
  const cli = type === "codebuddy", official = type === "deepseek";
  byId("model-address").hidden = byId("model-key").hidden = cli;
  fields.endpoint.readOnly = official;
  fields.endpoint.required = !cli;
  if (reset) {
    fields.endpoint.value = official ? modelOptions.officialEndpoint : "";
    fields.model.value = cli ? "auto" : official ? modelOptions.models[0] : "";
    fields.key.value = "";
  }
  byId("model-options").replaceChildren(...(official ? modelOptions.models : cli ? ["auto", "hy4-preview"] : [])
    .map(name => element("option", name)));
  byId("model-hint").textContent = cli
    ? "先通过官方 CodeBuddy CLI 登录，再测试连接。"
    : "API Key 留空时，仅复用同一接口已保存的密钥。";
}
async function openModelPanel() {
  if (!api || modelPanel.open) return;
  try {
    modelOptions = await api.model_settings();
    for (const field of ["provider", "endpoint", "model"]) modelForm.elements[field].value = modelOptions[field];
    modelForm.elements.key.value = "";
    byId("model-status").textContent = "";
    syncModelFields(false);
    modelPanel.showModal();
    refreshCliStatus();
  } catch (error) { byId("feedback").textContent = error.message || String(error); }
}
modelForm.elements.provider.onchange = () => syncModelFields(true);
modelForm.onsubmit = async event => {
  event.preventDefault();
  const button = event.submitter;
  if (button.disabled) return;
  button.disabled = true;
  byId("model-status").textContent = "正在测试连接…";
  try {
    modelOptions = await api.save_model_settings(Object.fromEntries(new FormData(modelForm)));
    modelForm.elements.key.value = "";
    byId("model-status").textContent = "连接成功，调度模型设置已保存。";
    if (byId("cli-auto").checked) installCli();
  } catch (error) { byId("model-status").textContent = error.message || String(error); }
  finally { button.disabled = false; }
};

const cliInstall = byId("cli-install");
const cliStatus = byId("cli-status");
const cliLoginButtons = [...modelPanel.querySelectorAll("[data-cli-login]")];
let cliInstalling = false;
let cliStatusRun = 0;

async function refreshCliStatus() {
  const run = ++cliStatusRun;
  try {
    const result = await api.cli_status();
    if (run !== cliStatusRun) return;
    cliInstall.disabled = cliInstalling || result.running;
    for (const button of cliLoginButtons) {
      button.disabled = cliInstall.disabled || !result.available[button.dataset.cliLogin];
    }
    if (result.running) cliStatus.textContent = result.message;
  } catch (error) {
    if (run === cliStatusRun && !cliInstalling) cliStatus.textContent = error.message || String(error);
  }
}

async function installCli() {
  if (!api || cliInstalling) return;
  cliInstalling = cliInstall.disabled = true;
  for (const button of cliLoginButtons) button.disabled = true;
  cliStatus.textContent = "正在检查 CLI 版本…";
  const timer = setInterval(refreshCliStatus, 800);
  try {
    const {versions, failures} = await api.install_cli();
    cliStatus.textContent = [["codex", "Codex"], ["codebuddy", "CodeBuddy"]]
      .map(([key, name]) => `${name}：${versions[key] || failures[key] || "未安装"}`).join("\n");
  } catch (error) {
    cliStatus.textContent = error.message || String(error);
  } finally {
    clearInterval(timer);
    cliInstalling = false;
    refreshCliStatus();
  }
}

cliInstall.onclick = installCli;
for (const button of cliLoginButtons) {
  button.onclick = async () => {
    try {
      await api.cli_login(button.dataset.cliLogin);
      cliStatus.textContent = button.dataset.cliLogin === "codebuddy"
        ? "已打开 CodeBuddy 控制台，请按提示登录，必要时输入 /login。"
        : "已打开 Codex 登录窗口，请按提示完成登录。";
    } catch (error) { cliStatus.textContent = error.message || String(error); }
  };
}

function renderResultTab() {
  if (!resultData) return;
  const picture = resultTab === "picture";
  byId("result-picture").hidden = !picture;
  const image = byId("result-image");
  if (picture) {
    image.hidden = !resultData.picture;
    if (resultData.picture && image.getAttribute("src") !== resultData.picture) image.src = resultData.picture;
    if (!resultData.picture) image.removeAttribute("src");
  }
  const content = picture ? resultData.source || (resultData.picture ? "" : resultData.hasPicture ? "正在读取配图…" : "暂无配图")
    : resultTab === "activity" ? resultData.activity : resultData.tabs[resultTab] || "暂无成果";
  const output = byId("results-content");
  if (resultContentKey?.tab !== resultTab || resultContentKey?.text !== content) {
    resultContentKey = {tab: resultTab, text: content};
    output.textContent = resultTab === "body" ? "" : content;
    if (resultTab === "body") appendManuscript(output, content);
  }
  document.querySelectorAll("[data-result-tab]").forEach(button =>
    button.setAttribute("aria-pressed", button.dataset.resultTab === resultTab));
}
async function refreshTaskResults() {
  const run = ++resultRun;
  try {
    const data = await api.task_results(resultTarget, resultData ? resultKind.value : "", resultTab === "picture");
    if (run !== resultRun || !resultsPanel.open) return;
    resultData = data;
    resultKind.value = data.pictureKind;
    byId("results-title").textContent = data.title;
    byId("results-status").textContent = [data.provider, data.status, data.detail].filter(Boolean).join(" · ");
    const steps = byId("results-steps");
    steps.hidden = !data.steps?.length;
    const stepKey = JSON.stringify(data.steps);
    if (resultStepsKey !== stepKey) {
      steps.replaceChildren(...(data.steps || []).map(step =>
        element("li", [step.label, step.status, step.detail].filter(Boolean).join(" · "))));
      resultStepsKey = stepKey;
    }
    byId("result-followup").hidden = !data.waiting;
    resultsPanel.querySelector('[data-result="retry"]').textContent = data.steps?.length ? "重试未完成步骤" : "重试";
    resultsPanel.querySelector('[data-result="rebuild"]').hidden = !data.rebuild;
    for (const [name, enabled] of Object.entries({copy: data.handoff, retry: data.retry && !data.waiting,
      stop: data.stop, export: data.export, picture: data.hasPicture})) {
      resultsPanel.querySelector('[data-result="' + name + '"]').disabled = !enabled;
    }
    renderResultTab();
  } catch (error) {
    if (run === resultRun) byId("results-status").textContent = error.message || String(error);
  }
}
function openResults(target) {
  if (!api || !target || resultsPanel.open) return;
  resultTarget = target;
  resultData = null;
  resultContentKey = resultStepsKey = null;
  resultTab = "body";
  resultKind.value = "figure";
  byId("results-title").textContent = "任务成果";
  byId("results-status").textContent = "正在读取任务…";
  byId("results-content").textContent = "";
  byId("results-steps").hidden = true;
  byId("result-picture").hidden = byId("result-followup").hidden = true;
  resultsPanel.querySelectorAll("[data-result]").forEach(button => button.disabled = true);
  resultsPanel.showModal();
  refreshTaskResults();
}
async function performResult(name, answer = "") {
  try {
    if (name === "copy") {
      await api.result_action(resultTarget, name, resultKind.value);
      byId("results-status").textContent = "已复制豆包指令。";
      return;
    }
    await api.result_action(resultTarget, name, resultKind.value, answer);
    await refreshTaskResults();
  } catch (error) { byId("results-status").textContent = error.message || String(error); }
}
resultsPanel.querySelectorAll("[data-result]").forEach(button =>
  button.onclick = () => performResult(button.dataset.result));
resultsPanel.querySelectorAll("[data-result-tab]").forEach(button => button.onclick = () => {
  resultTab = button.dataset.resultTab;
  renderResultTab();
  if (resultTab === "picture") refreshTaskResults();
});
resultKind.onchange = refreshTaskResults;
byId("result-followup").onsubmit = event => {
  event.preventDefault();
  performResult("retry", event.target.elements.answer.value);
};

const readProjectDialog = byId("read-project-dialog");
const readProjectName = byId("read-project-name");

function confirmProjectReading() {
  if (!state?.id || busy || readProjectDialog.open) return;
  readProjectName.textContent = state.project;
  readProjectDialog.showModal();
}

byId("read-project-confirm").onclick = () => {
  if (busy || !state?.id) return;
  const confirmedProject = readProjectName.textContent;
  readProjectDialog.close();
  if (state.project === confirmedProject) action("read_project");
};

document.querySelectorAll("[data-action]").forEach(button => button.onclick = () => {
  const name = button.dataset.action;
  if (name === "read_project") confirmProjectReading();
  else if (name === "export") openProjectExport();
  else if (name === "new") openNewSection();
  else if (name === "settings") openModelPanel();
  else if (name === "results") openResults(state?.id);
  else action(name);
});
document.querySelectorAll("[data-mode]").forEach(button => button.onclick = () => {
  mode = button.dataset.mode;
  document.querySelectorAll("[data-mode]").forEach(item => item.setAttribute("aria-pressed", item === button));
  showReferenceZone();
});
document.querySelectorAll("[data-tab]").forEach(button => button.onclick = async () => {
  if (busy || tab === button.dataset.tab) return;
  commitInline();
  tab = button.dataset.tab;
  page = 0;
  renderedKey = "";
  ++pageRun;
  controls();
  if (tab === "edit") manuscript.focus();
  else await action("sync");
});
byId("composer").onsubmit = event => {
  event.preventDefault();
  action("send");
};
request.onkeydown = event => {
  if (event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    byId("composer").requestSubmit();
  }
};
manuscript.oninput = controls;
manuscript.addEventListener("compositionstart", () => { composingManuscript = true; });
manuscript.addEventListener("compositionend", () => { composingManuscript = false; });
manuscript.onkeydown = event => {
  if (event.key.toLowerCase() === "s" && event.ctrlKey) {
    event.preventDefault();
    action("save");
  }
};
byId("previous").onclick = () => goToPage(page - 1);
byId("next").onclick = () => goToPage(page + 1);
function changeZoom(next, pointer) {
  next = Math.max(minimumZoom, Math.min(maximumZoom, next));
  if (next === zoom || !sheets.length || tab === "edit") return;

  const viewport = documentScroll.getBoundingClientRect();
  const x = pointer?.clientX ?? viewport.left + documentScroll.clientWidth / 2;
  const y = pointer?.clientY ?? viewport.top + documentScroll.clientHeight / 2;
  const anchor = pointer?.target.closest(".paper-sheet") ||
    sheets.find(sheet => sheet.node.getBoundingClientRect().bottom > y)?.node || sheets.at(-1).node;
  const before = anchor.getBoundingClientRect();
  const offsetX = Math.max(0, Math.min(1, (x - before.left) / before.width));
  const offsetY = Math.max(0, Math.min(1, (y - before.top) / before.height));

  zoom = next;
  for (const sheet of sheets) sheet.node.style.width = Math.round(zoom * 100) + "%";
  const after = anchor.getBoundingClientRect();
  documentScroll.scrollLeft += after.left - before.left + offsetX * (after.width - before.width);
  documentScroll.scrollTop += after.top - before.top + offsetY * (after.height - before.height);
  updateCurrentPage();

  // Recheck nearby pages at the new render size once the zoom gesture settles.
  clearTimeout(zoomRenderTimer);
  zoomRenderTimer = setTimeout(() => {
    if (!observer || tab === "edit") return;
    for (const sheet of sheets) {
      observer.unobserve(sheet.node);
      observer.observe(sheet.node);
    }
  }, 180);
}
byId("zoom-in").onclick = () => changeZoom(zoom + zoomStep);
byId("zoom-out").onclick = () => changeZoom(zoom - zoomStep);
byId("zoom").onclick = () => changeZoom(1);
documentScroll.addEventListener("wheel", event => {
  if (!event.ctrlKey || !event.deltaY) return;
  event.preventDefault();
  changeZoom(zoom - Math.sign(event.deltaY) * zoomStep, event);
}, {passive: false});
byId("retry").onclick = () => { renderedKey = ""; loadPage(); };
byId("outline-toggle").onclick = () => {
  closeOutlineMenu();
  const pane = byId("outline-pane");
  pane.hidden = !pane.hidden;
  byId("outline-splitter").hidden = pane.hidden;
  byId("outline-toggle").classList.toggle("current", !pane.hidden);
  fitColumns();
};
byId("preview-toggle").onclick = () => {
  const pane = byId("preview-pane");
  pane.hidden = !pane.hidden;
  byId("preview-splitter").hidden = pane.hidden;
  fitColumns();
  if (!pane.hidden && tab !== "edit") loadPage();
};
const appearancePanel = byId("appearance-panel");
const themes = {
  "石墨蓝": {background:"#181818", surface:"#1b2227", accent:"#3985e4"},
  "墨竹绿": {background:"#12201d", surface:"#1c2e28", accent:"#56b894"},
  "暮紫": {background:"#1d1927", surface:"#292338", accent:"#b496f1"},
  "暖纸": {background:"#f3efe7", surface:"#e8e0d3", accent:"#a05235"},
};
const themeKeys = ["background", "surface", "accent"];
const defaultAppearance = {...themes["石墨蓝"], decorations:true};
let savedAppearance = defaultAppearance, lastCaption = "", appearanceSaving = false;

function luminance(color) {
  const channels = color.slice(1).match(/../g).map(hex => parseInt(hex,16)/255)
    .map(value => value <= .04045 ? value/12.92 : ((value+.055)/1.055)**2.4);
  return channels[0]*.2126 + channels[1]*.7152 + channels[2]*.0722;
}
function mixColor(first, second, amount) {
  const a = first.slice(1).match(/../g), b = second.slice(1).match(/../g);
  return "#" + a.map((hex,i) => Math.round(parseInt(hex,16)*(1-amount)+parseInt(b[i],16)*amount)
    .toString(16).padStart(2,"0")).join("");
}
function inkFor(color) {
  return luminance(color) > .179 ? "#000000" : "#ffffff";
}
function applyAppearance(values) {
  const light = luminance(values.background) > .179;
  const ink = inkFor(values.background), surfaceInk = inkFor(values.surface);
  const button = values.accent;
  const bubble = mixColor(values.background,button,.31);
  const surfaceSelected = mixColor(values.surface, button, .19);
  const surfaceHover = mixColor(surfaceInk, values.surface, .89);
  const variables = {
    bg:values.background, surface:values.surface, accent:button, ink,
    "surface-ink":surfaceInk, "accent-ink":inkFor(button), "bubble-ink":inkFor(bubble),
    muted:mixColor(ink,values.background,.38), "surface-muted":mixColor(surfaceInk,values.surface,.35),
    line:mixColor(ink,values.background,.15), "surface-line":mixColor(surfaceInk,values.surface,.19),
    field:mixColor(values.surface,surfaceInk,.05), bubble,
    selected:mixColor(values.background,button,.23),
    "surface-selected":surfaceSelected, "surface-selected-ink":inkFor(surfaceSelected),
    "outline-indicator":mixColor(button, surfaceInk, .35),
    hover:mixColor(ink,values.background,.89),
    "surface-hover":surfaceHover, "surface-hover-ink":inkFor(surfaceHover),
  };
  for (const [key,value] of Object.entries(variables)) document.documentElement.style.setProperty("--"+key,value);
  document.documentElement.style.colorScheme = light ? "light" : "dark";
  document.body.classList.toggle("theme-art",values.decorations);
  const caption = values.surface + surfaceInk;
  if (api && lastCaption !== caption) {
    lastCaption = caption;
    api.appearance_caption(values.surface,surfaceInk === "#000000").catch(() => {});
  }
}
function currentAppearance() {
  return {...Object.fromEntries(themeKeys.map(key => [key,byId("color-"+key).value])),
    decorations:byId("appearance-decorations").checked};
}
function fillAppearance(values) {
  for (const key of themeKeys) byId("color-"+key).value = values[key];
  byId("appearance-decorations").checked = values.decorations;
  applyAppearance(values);
}
byId("appearance-presets").replaceChildren(...Object.entries(themes).map(([name,values]) => {
  const button = element("button",name,"theme-preset");
  button.type = "button";
  const swatch = element("span","","theme-swatch");
  swatch.style.background = values.accent;
  button.prepend(swatch);
  button.onclick = () => fillAppearance({...values,decorations:currentAppearance().decorations});
  return button;
}));
appearancePanel.oninput = () => applyAppearance(currentAppearance());
appearancePanel.onclose = () => applyAppearance(savedAppearance);
appearancePanel.oncancel = event => { if (appearanceSaving) event.preventDefault(); };
byId("appearance-open").onclick = () => {
  fillAppearance(savedAppearance);
  byId("appearance-status").textContent = "";
  appearancePanel.showModal();
};
byId("appearance-reset").onclick = () => fillAppearance(defaultAppearance);
byId("appearance-save").onclick = async () => {
  if (!api || appearanceSaving) return;
  appearanceSaving = true;
  byId("appearance-save").disabled = true;
  try {
    savedAppearance = await api.save_appearance(currentAppearance());
    appearancePanel.close();
  } catch (error) { byId("appearance-status").textContent = error.message || String(error); }
  finally { appearanceSaving = false; byId("appearance-save").disabled = false; }
};
applyAppearance(defaultAppearance);

window.addEventListener("pywebviewready", async () => {
  api = window.pywebview.api;
  try {
    const stored = await api.appearance();
    if (themeKeys.every(key => /^#[0-9a-f]{6}$/i.test(stored?.[key]))) {
      savedAppearance = {...defaultAppearance,...stored};
    }
  } catch {}
  applyAppearance(savedAppearance);
  await poll();
  setInterval(poll, 1200);
  setInterval(updateCollaboration, 1200);
  setInterval(() => { if (resultsPanel.open) refreshTaskResults(); }, 2500);
  setInterval(() => {
    if (state?.id) action("autosave");
  }, autosaveInterval);
});

window.closeWorkspace = async () => {
  if (!api || closing) return;
  if (busy) { closePending = true; return; }
  closePending = false;
  commitInline();
  closing = busy = true;
  controls();
  try {
    if (await api.close_workspace(inputs())) await api.finish_close();
  } catch (error) {
    byId("feedback").textContent = error.message || String(error);
  } finally {
    closing = busy = false;
    controls();
  }
};
