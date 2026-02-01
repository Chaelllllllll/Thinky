(function(){
    // Simple modal helper exposing showModal, showConfirm, showPrompt
    function ensureContainer(){
        let c = document.getElementById('modalHelperContainer');
        if(!c){
            c = document.createElement('div');
            c.id = 'modalHelperContainer';
            document.body.appendChild(c);
        }
        return c;
    }

    function buildModal({title='', message='', html=false, buttons=[{label:'OK', value:true, className:'btn-primary'}], onClose=null, small=false}){
        const container = ensureContainer();
        const overlay = document.createElement('div');
        overlay.className = 'modal modal-helper-overlay';
        overlay.style.display = 'flex';
        overlay.style.position = 'fixed';
        overlay.style.left = 0;
        overlay.style.top = 0;
        overlay.style.right = 0;
        overlay.style.bottom = 0;
        overlay.style.background = 'rgba(0,0,0,0.5)';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = 9999;
        overlay.style.pointerEvents = 'auto';

        const box = document.createElement('div');
        box.className = 'modal-content modal-helper-box';
        // If caller requested small OR viewport is narrow, force compact modal
        const isSmall = !!small || (typeof window !== 'undefined' && window.innerWidth <= 480);
        if (isSmall) box.classList.add('modal-helper-small');
        box.style.maxWidth = isSmall ? '320px' : '560px';
        box.style.width = isSmall ? '92%' : '90%';
        box.style.background = '#fff';
        box.style.borderRadius = isSmall ? '12px' : '8px';
        box.style.boxShadow = '0 12px 40px rgba(0,0,0,0.25)';
        box.style.overflow = 'hidden';
        box.style.pointerEvents = 'auto';
        box.style.position = 'relative';
        box.style.zIndex = 10000;
        if (isSmall) {
            // place near top on small screens for better ergonomics
            overlay.style.alignItems = 'flex-start';
            overlay.style.paddingTop = '8vh';
        }

        const header = document.createElement('div');
        header.className = 'modal-helper-header';
        header.style.padding = '16px 18px';
        header.style.borderBottom = '1px solid #eee';
        header.style.fontWeight = 700;
        header.textContent = title || '';

        const body = document.createElement('div');
        body.className = 'modal-helper-body';
        body.style.padding = '18px';
        body.style.overflow = 'visible';
        body.style.maxHeight = 'none';
        body.style.pointerEvents = 'auto';
        if(html) body.innerHTML = message || '';
        else body.textContent = message || '';

        const footer = document.createElement('div');
        footer.className = 'modal-helper-footer';
        footer.style.padding = '12px 16px';
        footer.style.borderTop = '1px solid #eee';
        footer.style.textAlign = 'right';
        footer.style.display = 'flex';
        footer.style.gap = '8px';
        footer.style.justifyContent = 'flex-end';

        buttons.forEach(btn => {
            const b = document.createElement('button');
            b.className = btn.className ? ('btn '+btn.className) : 'btn btn-light';
            b.textContent = btn.label;
            b.onclick = () => {
                try{ if(typeof btn.onClick === 'function') btn.onClick(); }catch(e){}
                cleanup();
                if(onClose) onClose(btn.value);
            };
            footer.appendChild(b);
        });

        box.appendChild(header);
        box.appendChild(body);
        box.appendChild(footer);
        overlay.appendChild(box);
        container.appendChild(overlay);

        // allow escape to close (resolve with null)
        function escHandler(e){ if(e.key === 'Escape'){ cleanup(); if(onClose) onClose(null); } }
        document.addEventListener('keydown', escHandler);
        overlay.addEventListener('click', (ev)=>{
            if(ev.target === overlay){ cleanup(); if(onClose) onClose(null); }
        });
        function cleanup(){
            try{ document.removeEventListener('keydown', escHandler); overlay.remove(); }catch(e){}
        }

        return {overlay, box, cleanup};
    }

    window.showModal = function(message, title='Notice', opts={}){
        return new Promise(resolve => {
            const buttons = opts.noButtons ? [] : [{label:opts.okText||'OK', value:true, className: opts.okClass||'btn-primary'}];
            buildModal({title, message, html: opts.html||false, buttons, onClose: ()=>resolve(true), small: !!opts.small});
        });
    };

    window.showConfirm = function(message, title='Confirm'){
        return new Promise(resolve => {
            buildModal({
                title,
                message,
                buttons:[
                    {label:'Cancel', value:false, className:'btn-light'},
                    {label:'OK', value:true, className:'btn-primary'}
                ],
                onClose: (val)=> resolve(!!val)
            });
        });
    };

    window.showPrompt = function(message, title='Input', opts={placeholder:'', defaultValue:''}){
        return new Promise(resolve => {
            const container = ensureContainer();
            const overlay = document.createElement('div');
            overlay.className = 'modal modal-helper-overlay';
            overlay.style.display = 'flex';
            overlay.style.position = 'fixed';
            overlay.style.left = 0;
            overlay.style.top = 0;
            overlay.style.right = 0;
            overlay.style.bottom = 0;
            overlay.style.background = 'rgba(0,0,0,0.5)';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.style.zIndex = 9999;

            const box = document.createElement('div');
            box.className = 'modal-content modal-helper-box';
            // auto-switch to compact layout on narrow viewports
            const isSmallPrompt = (typeof window !== 'undefined' && window.innerWidth <= 480);
            if (isSmallPrompt) box.classList.add('modal-helper-small');
            box.style.maxWidth = isSmallPrompt ? '320px' : '560px';
            box.style.width = isSmallPrompt ? '92%' : '90%';
            box.style.background = '#fff';
            box.style.borderRadius = '8px';
            box.style.boxShadow = '0 12px 40px rgba(0,0,0,0.25)';
            box.style.overflow = 'hidden';

            const header = document.createElement('div');
            header.className = 'modal-helper-header';
            header.style.padding = '16px 18px';
            header.style.borderBottom = '1px solid #eee';
            header.style.fontWeight = 700;
            header.textContent = title || '';

            const body = document.createElement('div');
            body.className = 'modal-helper-body';
            body.style.padding = '18px';

            const p = document.createElement('div');
            p.style.marginBottom = '12px';
            p.textContent = message || '';

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = opts.placeholder || '';
            input.value = opts.defaultValue || '';
            input.style.width = '100%';
            input.style.padding = '10px';
            input.style.border = '1px solid #ddd';
            input.style.borderRadius = '6px';

            body.appendChild(p);
            body.appendChild(input);

            const footer = document.createElement('div');
            footer.className = 'modal-helper-footer';
            footer.style.padding = '12px 16px';
            footer.style.borderTop = '1px solid #eee';
            footer.style.textAlign = 'right';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn btn-light';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.onclick = ()=>{ cleanup(); resolve(null); };

            const okBtn = document.createElement('button');
            okBtn.className = 'btn btn-primary';
            okBtn.textContent = 'OK';
            okBtn.style.marginLeft = '8px';
            okBtn.onclick = ()=>{ cleanup(); resolve(input.value); };

            footer.appendChild(cancelBtn);
            footer.appendChild(okBtn);

            box.appendChild(header);
            box.appendChild(body);
            box.appendChild(footer);
            overlay.appendChild(box);
            container.appendChild(overlay);

            input.focus();
            function escHandler(e){ if(e.key === 'Escape'){ cleanup(); resolve(null); } }
            document.addEventListener('keydown', escHandler);
            overlay.addEventListener('click', (ev)=>{ if(ev.target === overlay){ cleanup(); resolve(null); } });
            function cleanup(){ try{ document.removeEventListener('keydown', escHandler); overlay.remove(); }catch(e){} }
        });
    };
})();
