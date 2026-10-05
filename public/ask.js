// Text input in Corkboard's own dialog. window.prompt() does not work in the desktop app (Electron).
// Resolves to the trimmed text, '' when the field is empty, or null on Cancel / Esc.
export function askText(title, value = '', { okLabel = 'OK', placeholder = '', allowEmpty = false } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'ask-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    const label = Object.assign(document.createElement('label'), { textContent: title });
    const input = Object.assign(document.createElement('input'), { type: 'text', value, placeholder, spellcheck: false });
    const row = Object.assign(document.createElement('div'), { className: 'ask-buttons' });
    const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancel' });
    const ok = Object.assign(document.createElement('button'), { type: 'submit', textContent: okLabel, className: 'primary' });
    row.append(cancel, ok);
    label.append(input);
    form.append(label, row);
    dlg.append(form);
    document.body.append(dlg);

    let result = null;
    const sync = () => { ok.disabled = !allowEmpty && !input.value.trim(); };
    input.addEventListener('input', sync);
    cancel.onclick = () => dlg.close();
    form.onsubmit = () => { result = input.value.trim(); };
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    sync();
    dlg.showModal();
    input.focus();
    input.select();
  });
}

// Yes/no in Corkboard's own dialog, with an optional checkbox.
// Resolves to { checked } on OK, or null on Cancel / Esc.
export function askConfirm(title, message, { okLabel = 'OK', danger = false, checkbox = null } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'ask-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.append(Object.assign(document.createElement('h3'), { textContent: title }));
    for (const line of [].concat(message || [])) form.append(Object.assign(document.createElement('p'), { textContent: line }));
    let box = null;
    if (checkbox) {
      const label = Object.assign(document.createElement('label'), { className: 'ask-check' });
      box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!checkbox.checked });
      label.append(box, document.createTextNode(` ${checkbox.label}`));
      form.append(label);
    }
    const row = Object.assign(document.createElement('div'), { className: 'ask-buttons' });
    const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancel' });
    const ok = Object.assign(document.createElement('button'), { type: 'submit', textContent: okLabel, className: danger ? 'primary danger' : 'primary' });
    row.append(cancel, ok);
    form.append(row);
    dlg.append(form);
    document.body.append(dlg);
    let result = null;
    cancel.onclick = () => dlg.close();
    form.onsubmit = () => { result = { checked: !!box?.checked }; };
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.showModal();
    cancel.focus();
  });
}
