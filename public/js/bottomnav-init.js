// Shared bottom navigation initialization
window.BottomNavUtils = {
    getCurrentPage() {
        const path = window.location.pathname;
        const filename = path.split('/').pop();
        
        switch(filename) {
            case 'index.html':
            case '':
            case 'app':
            case '/':
                return 'home';
            case 'sell.html':
            case 'sell':
                return 'sell';
            case 'history.html':
            case 'history':
                return 'history';
            case 'referral.html':
            case 'referral':
                return 'referral';
            case 'about.html':
            case 'about':
                return 'about';
            default:
                return 'home';
        }
    },

    setActiveNavigation() {
        const currentPage = this.getCurrentPage();
        const navLinks = document.querySelectorAll('.nav-link');
        
        if (navLinks.length === 0) {
            console.warn('Bottom nav links not found');
            return;
        }
        
        navLinks.forEach(link => {
            link.classList.remove('active');
            if (link.getAttribute('data-page') === currentPage) {
                link.classList.add('active');
            }
        });
    },

    initBottomNav() {
        this.setActiveNavigation();
    }
};
