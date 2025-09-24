(function(){
	function injectFragment(containerId, url){
		var c = document.getElementById(containerId);
		if(!c) return;
		fetch(url, { cache: 'no-cache' }).then(function(r){return r.text();}).then(function(html){ c.innerHTML = html; }).catch(function(){});
	}
	window.CommonUI = {
		loadHeader: function(){ injectFragment('header-container','/header.html'); },
		loadBottomNav: function(){ injectFragment('bottomnav-container','/bottomnav.html'); }
	};
})();
