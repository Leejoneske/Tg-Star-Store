/* Lightweight SweetAlert2-compatible modal shim using theme tokens. */
(function () {
  if (window.Swal && window.Swal.__lovableShim) return;

  const CSS = `
  .lv-swal-backdrop{position:fixed;inset:0;background:rgba(8,12,20,.55);backdrop-filter:blur(4px);
    display:flex;align-items:center;justify-content:center;z-index:99999;opacity:0;transition:opacity .18s ease;padding:16px;}
  .lv-swal-backdrop.show{opacity:1}
  .lv-swal{background:var(--surface,#fff);color:var(--text,#111);border-radius:16px;
    max-width:420px;width:100%;padding:24px 22px 20px;box-shadow:0 24px 60px -16px rgba(0,0,0,.4),0 4px 16px rgba(0,0,0,.12);
    transform:translateY(8px) scale(.98);transition:transform .2s cubic-bezier(.2,.8,.2,1),opacity .18s;
    opacity:0;border:1px solid var(--border,rgba(0,0,0,.06));}
  .lv-swal-backdrop.show .lv-swal{transform:translateY(0) scale(1);opacity:1}
  .lv-swal-icon{width:64px;height:64px;margin:4px auto 14px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    font-size:34px;font-weight:700;line-height:1;animation:lvPop .35s cubic-bezier(.2,1.2,.4,1);}
  @keyframes lvPop{0%{transform:scale(.3);opacity:0}60%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}
  .lv-swal-icon.success{background:rgba(34,197,94,.12);color:#22c55e}
  .lv-swal-icon.error{background:rgba(239,68,68,.12);color:#ef4444}
  .lv-swal-icon.warning{background:rgba(245,158,11,.14);color:#f59e0b}
  .lv-swal-icon.info{background:rgba(59,130,246,.14);color:#3b82f6}
  .lv-swal-icon.question{background:rgba(139,92,246,.14);color:#8b5cf6}
  .lv-swal-icon svg{width:38px;height:38px}
  .lv-swal-title{font-size:1.25rem;font-weight:700;text-align:center;margin:0 0 8px;color:var(--text,#111);line-height:1.3}
  .lv-swal-content{text-align:center;color:var(--text-secondary,#5b6573);font-size:.95rem;line-height:1.5;margin:0 0 14px}
  .lv-swal-content:empty{display:none}
  .lv-swal-input,.lv-swal-textarea{width:100%;padding:11px 14px;border-radius:10px;border:1px solid var(--border,#d6dbe2);
    background:var(--surface-2,#fff);color:var(--text,#111);font:inherit;font-size:1rem;outline:none;transition:border-color .15s,box-shadow .15s;
    margin:6px 0;box-sizing:border-box;}
  .lv-swal-textarea{min-height:88px;resize:vertical;font-family:inherit}
  .lv-swal-input:focus,.lv-swal-textarea:focus{border-color:var(--brand,#3b82f6);box-shadow:0 0 0 3px color-mix(in oklab,var(--brand,#3b82f6) 20%,transparent)}
  .lv-swal-validation{display:none;background:rgba(239,68,68,.1);color:#ef4444;border-radius:8px;padding:8px 12px;font-size:.85rem;margin-top:8px;text-align:left}
  .lv-swal-validation.show{display:block}
  .lv-swal-actions{display:flex;gap:8px;margin-top:18px;justify-content:center;flex-wrap:wrap}
  .lv-swal-actions.reverse{flex-direction:row-reverse}
  .lv-swal-btn{appearance:none;border:0;padding:10px 22px;border-radius:10px;font:inherit;font-weight:600;font-size:.95rem;
    cursor:pointer;min-width:96px;transition:transform .08s ease,filter .15s,box-shadow .15s;}
  .lv-swal-btn:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in oklab,var(--brand,#3b82f6) 35%,transparent)}
  .lv-swal-btn:active{transform:scale(.97)}
  .lv-swal-btn:disabled{opacity:.6;cursor:not-allowed}
  .lv-swal-confirm{background:var(--brand,#3b82f6);color:#fff}
  .lv-swal-confirm:hover{filter:brightness(1.06)}
  .lv-swal-cancel{background:var(--surface-2,#eef1f5);color:var(--text,#111)}
  .lv-swal-cancel:hover{filter:brightness(.97)}
  .lv-swal-footer{margin-top:14px;padding-top:12px;border-top:1px solid var(--border,rgba(0,0,0,.08));text-align:center;font-size:.85rem;color:var(--text-muted,#7b8593)}
  .lv-swal-loader{display:flex;justify-content:center;margin:12px 0}
  .lv-swal-loader::after{content:"";width:34px;height:34px;border:3px solid color-mix(in oklab,var(--brand,#3b82f6) 30%,transparent);
    border-top-color:var(--brand,#3b82f6);border-radius:50%;animation:lvSpin .8s linear infinite}
  @keyframes lvSpin{to{transform:rotate(360deg)}}
  .lv-swal-progress{height:3px;background:color-mix(in oklab,var(--brand,#3b82f6) 25%,transparent);border-radius:3px;margin-top:14px;overflow:hidden;position:relative}
  .lv-swal-progress::after{content:"";position:absolute;inset:0;background:var(--brand,#3b82f6);transform-origin:left;animation:lvBar var(--lv-dur,3s) linear forwards}
  @keyframes lvBar{from{transform:scaleX(1)}to{transform:scaleX(0)}}
  body.lv-swal-open{overflow:hidden}
  `;

  function injectStyle() {
    if (document.getElementById('lv-swal-style')) return;
    const s = document.createElement('style');
    s.id = 'lv-swal-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  const ICON_SVG = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    question: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
  };

  let current = null;

  function buildModal(opts) {
    const backdrop = document.createElement('div');
    backdrop.className = 'lv-swal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    const modal = document.createElement('div');
    modal.className = 'lv-swal' + (opts.customClass && opts.customClass.popup ? ' ' + opts.customClass.popup : '');
    backdrop.appendChild(modal);

    if (opts.icon && ICON_SVG[opts.icon]) {
      const ic = document.createElement('div');
      ic.className = 'lv-swal-icon ' + opts.icon;
      ic.innerHTML = ICON_SVG[opts.icon];
      modal.appendChild(ic);
    }

    if (opts.title) {
      const t = document.createElement('h3');
      t.className = 'lv-swal-title';
      t.innerHTML = opts.title;
      modal.appendChild(t);
    }

    const content = document.createElement('div');
    content.className = 'lv-swal-content';
    if (opts.html) content.innerHTML = opts.html;
    else if (opts.text) content.textContent = opts.text;
    modal.appendChild(content);

    let input = null;
    if (opts.input) {
      if (opts.input === 'textarea') {
        input = document.createElement('textarea');
        input.className = 'lv-swal-textarea';
      } else {
        input = document.createElement('input');
        input.className = 'lv-swal-input';
        input.type = opts.input;
      }
      if (opts.inputPlaceholder) input.placeholder = opts.inputPlaceholder;
      if (opts.inputValue != null) input.value = opts.inputValue;
      if (opts.inputAttributes) {
        for (const k in opts.inputAttributes) input.setAttribute(k, opts.inputAttributes[k]);
      }
      modal.appendChild(input);
    }

    const validation = document.createElement('div');
    validation.className = 'lv-swal-validation';
    modal.appendChild(validation);

    const loader = document.createElement('div');
    loader.className = 'lv-swal-loader';
    loader.style.display = 'none';
    modal.appendChild(loader);

    const actions = document.createElement('div');
    actions.className = 'lv-swal-actions' + (opts.reverseButtons ? ' reverse' : '');

    const showConfirm = opts.showConfirmButton !== false;
    let confirmBtn = null, cancelBtn = null;

    if (showConfirm) {
      confirmBtn = document.createElement('button');
      confirmBtn.className = 'lv-swal-btn lv-swal-confirm';
      confirmBtn.type = 'button';
      confirmBtn.textContent = opts.confirmButtonText || 'OK';
      if (opts.confirmButtonColor) confirmBtn.style.background = opts.confirmButtonColor;
      actions.appendChild(confirmBtn);
    }
    if (opts.showCancelButton) {
      cancelBtn = document.createElement('button');
      cancelBtn.className = 'lv-swal-btn lv-swal-cancel';
      cancelBtn.type = 'button';
      cancelBtn.textContent = opts.cancelButtonText || 'Cancel';
      if (opts.cancelButtonColor) cancelBtn.style.background = opts.cancelButtonColor;
      actions.appendChild(cancelBtn);
    }
    if (showConfirm || opts.showCancelButton) modal.appendChild(actions);

    if (opts.footer) {
      const f = document.createElement('div');
      f.className = 'lv-swal-footer';
      f.innerHTML = opts.footer;
      modal.appendChild(f);
    }

    if (opts.timer && opts.timerProgressBar !== false) {
      const p = document.createElement('div');
      p.className = 'lv-swal-progress';
      p.style.setProperty('--lv-dur', (opts.timer / 1000) + 's');
      modal.appendChild(p);
    }

    return { backdrop, modal, input, validation, loader, confirmBtn, cancelBtn, content, actions };
  }

  function fire(opts) {
    injectStyle();
    opts = opts || {};
    if (current) closeNow('cancel');

    const parts = buildModal(opts);
    document.body.appendChild(parts.backdrop);
    document.body.classList.add('lv-swal-open');
    requestAnimationFrame(() => parts.backdrop.classList.add('show'));

    return new Promise((resolve) => {
      let settled = false;
      let timerId = null;

      function settle(result) {
        if (settled) return;
        settled = true;
        if (timerId) clearTimeout(timerId);
        document.removeEventListener('keydown', onKey);
        if (typeof opts.willClose === 'function') { try { opts.willClose(parts.modal); } catch(e){} }
        parts.backdrop.classList.remove('show');
        setTimeout(() => {
          if (parts.backdrop.parentNode) parts.backdrop.parentNode.removeChild(parts.backdrop);
          if (current && current.parts === parts) current = null;
          if (!document.querySelector('.lv-swal-backdrop')) document.body.classList.remove('lv-swal-open');
          resolve(result);
        }, 180);
      }

      function showValidation(msg) {
        parts.validation.textContent = msg;
        parts.validation.classList.add('show');
      }
      function clearValidation() { parts.validation.classList.remove('show'); }

      function setLoading(on) {
        parts.loader.style.display = on ? 'flex' : 'none';
        if (parts.confirmBtn) parts.confirmBtn.disabled = on;
        if (parts.cancelBtn) parts.cancelBtn.disabled = on;
        if (parts.input) parts.input.disabled = on;
      }

      async function doConfirm() {
        clearValidation();
        let value = parts.input ? parts.input.value : true;
        if (opts.inputValidator) {
          const err = await opts.inputValidator(value);
          if (err) { showValidation(err); return; }
        }
        if (opts.preConfirm) {
          setLoading(true);
          try {
            const r = await opts.preConfirm(value);
            if (r === false || parts.validation.classList.contains('show')) { setLoading(false); return; }
            value = (r === undefined) ? value : r;
          } catch (e) {
            showValidation(e && e.message ? e.message : String(e));
            setLoading(false);
            return;
          }
          setLoading(false);
        }
        settle({ isConfirmed: true, isDismissed: false, isDenied: false, value });
      }

      if (parts.confirmBtn) parts.confirmBtn.addEventListener('click', doConfirm);
      if (parts.cancelBtn) parts.cancelBtn.addEventListener('click', () =>
        settle({ isConfirmed: false, isDismissed: true, isDenied: false, value: null, dismiss: 'cancel' }));

      parts.backdrop.addEventListener('click', (e) => {
        if (e.target === parts.backdrop && opts.allowOutsideClick !== false)
          settle({ isConfirmed: false, isDismissed: true, value: null, dismiss: 'backdrop' });
      });

      function onKey(e) {
        if (e.key === 'Escape' && opts.allowEscapeKey !== false) {
          settle({ isConfirmed: false, isDismissed: true, value: null, dismiss: 'esc' });
        } else if (e.key === 'Enter' && parts.input && parts.input.tagName !== 'TEXTAREA') {
          e.preventDefault();
          doConfirm();
        }
      }
      document.addEventListener('keydown', onKey);

      if (parts.input) setTimeout(() => parts.input.focus(), 60);
      else if (parts.confirmBtn && opts.focusConfirm !== false) setTimeout(() => parts.confirmBtn.focus(), 60);

      if (opts.timer) timerId = setTimeout(() =>
        settle({ isConfirmed: false, isDismissed: true, value: null, dismiss: 'timer' }), opts.timer);

      current = { parts, settle, showValidation, setLoading };

      if (typeof opts.didOpen === 'function') { try { opts.didOpen(parts.modal); } catch(e){} }
    });
  }

  function closeNow(reason) {
    if (current) current.settle({ isConfirmed: false, isDismissed: true, value: null, dismiss: reason || 'close' });
  }

  const Swal = {
    __lovableShim: true,
    fire,
    close: closeNow,
    isVisible: () => !!current,
    showLoading: () => { if (current) current.setLoading(true); },
    hideLoading: () => { if (current) current.setLoading(false); },
    showValidationMessage: (msg) => { if (current) current.showValidation(msg); },
    resetValidationMessage: () => { if (current) current.parts.validation.classList.remove('show'); },
    update: (opts) => {
      if (!current) return;
      if (opts.title != null) {
        const t = current.parts.modal.querySelector('.lv-swal-title');
        if (t) t.innerHTML = opts.title;
      }
      if (opts.html != null) current.parts.content.innerHTML = opts.html;
      else if (opts.text != null) current.parts.content.textContent = opts.text;
    },
    getPopup: () => current ? current.parts.modal : null,
    getInput: () => current ? current.parts.input : null,
    mixin: (defaults) => ({
      fire: (opts) => fire(Object.assign({}, defaults, opts))
    })
  };

  window.Swal = Swal;
})();

