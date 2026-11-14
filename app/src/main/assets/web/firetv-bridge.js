// Fire TV stand-in for webOSTV.js.
//
// The Free My TV page calls webOS.service.request('luna://...', {method, parameters,
// onSuccess, onFailure}). This file answers the two calls it needs (listing and
// launching apps) through the Android `FireTV` bridge and fails everything else
// the same way webOS does, so the page's own fallbacks kick in. Plain ES5.
(function() {
    var pending = {};
    var nextId = 1;

    window.__fmtvResolve = function(id, res) {
        var call = pending[id];
        if (!call) return;
        delete pending[id];
        if (typeof res === 'string') {
            try { res = JSON.parse(res); } catch (e) { res = { returnValue: false, errorText: res }; }
        }
        res = res || { returnValue: false };
        if (res.returnValue === false) { if (call.onFailure) call.onFailure(res); }
        else if (call.onSuccess) call.onSuccess(res);
        if (call.onComplete) call.onComplete(res);
    };

    // In a desktop browser there is no bridge: leave window.webOS undefined so the
    // page shows its normal "preview" behaviour.
    if (!window.FireTV) return;

    function fail(id, text) {
        setTimeout(function() {
            window.__fmtvResolve(id, { returnValue: false, errorCode: -1, errorText: text });
        }, 0);
    }

    window.webOS = {
        platform: { tv: true, firetv: true },
        platformBack: function() {},
        service: {
            request: function(uri, options) {
                options = options || {};
                var id = nextId++;
                var params = options.parameters || {};
                pending[id] = options;
                if (/com\.webos\.applicationManager\/?$/.test(uri) && options.method === 'listLaunchPoints') {
                    window.FireTV.listLaunchPoints(id);
                } else if (/com\.webos\.applicationManager\/?$/.test(uri) && options.method === 'launch') {
                    window.FireTV.launch(id, String(params.id || ''), JSON.stringify(params.params || {}));
                } else {
                    fail(id, 'Not supported on Fire TV: ' + uri + ' ' + (options.method || ''));
                }
                return { cancel: function() { delete pending[id]; } };
            }
        }
    };
})();
