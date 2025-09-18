// Centralized translations for StarStore application
const translations = {
    en: {
        // Common UI elements
        appName: "StarStore",
        menu: "Menu",
        home: "Home",
        sell: "Sell",
        history: "History",
        referral: "Referral",
        about: "About",
        error: "Error",
        success: "Success",
        ok: "OK",
        warning: "Warning",
        continue: "Continue",
        cancel: "Cancel",
        loading: "Loading...",
        processing: "Processing...",
        loadingTransactionDetails: "Loading transaction details...",
        connectingToSupport: "Connecting to StarStore support...",
        important: "Important:",
        doubleCheckWallet: "Double-check your wallet address. Payments cannot be reversed once sent.",
        paymentConfirmation: "Payment Confirmation",
        aboutToSell: "You're about to sell",
        starsFor: "stars for",
        pleaseConfirmTransaction: "Please confirm this transaction via Telegram payment.",
        transactionDetails: "Transaction Details",
        amount: "Amount",
        toBeReceived: "To be received",
        currentStatus: "Current Status",
        estimatedCompletion: "Estimated Completion",
        progress: "Progress",
        estCompletion: "Est. completion:",
        buy: "Buy",
        starsDistribution: "Stars Distribution:",
        ifSetOverrides: "If set, this overrides the package selection.",
        enterTelegramUsernames: "Enter Telegram usernames.",
        maximumRecipientsAllowed: "Maximum 5 recipients allowed",
        needAtLeastStars: "Need at least {stars} stars for {count} recipients (50 stars minimum each)",
        accessDenied: "Access Denied",
        lookLikeLost: "Look like you're lost",
        pageNotAvailable: "the page you are looking for not available!",
        goToHome: "Go to Home",
        save: "Save",
        edit: "Edit",
        delete: "Delete",
        close: "Close",
        back: "Back",
        next: "Next",
        previous: "Previous",
        submit: "Submit",
        confirm: "Confirm",
        yes: "Yes",
        no: "No",
        retry: "Retry",
        refresh: "Refresh",
        copy: "Copy",
        share: "Share",
        search: "Search",
        filter: "Filter",
        sort: "Sort",
        view: "View",
        details: "Details",
        settings: "Settings",
        help: "Help",
        support: "Support",
        contact: "Contact",
        terms: "Terms & Conditions",
        privacy: "Privacy Policy",
        poweredBy: "Powered by",

        // Wallet and Payment
        connectWallet: "Connect Wallet",
        walletNotConnected: "Please connect your wallet to proceed.",
        walletConnected: "Wallet Connected",
        walletAddress: "Wallet Address",
        enterManually: "Enter wallet address manually",
        editAddress: "Edit Address",
        saveAddress: "Save Address",
        paymentInfo: "Payments will be made to the selected wallet.",
        paymentFailed: "Payment failed. Please try again later.",
        paymentSuccessful: "Payment Successful!",
        paymentProcessed: "Your payment has been successfully processed.",
        paymentInitiated: "Payment Initiated!",
        completePayment: "Please complete the payment in Telegram.",
        paymentNotSuccessful: "Your payment was not successful. Please try again.",
        paymentLinkMissing: "Payment Link Missing",
        paymentLinkNotGenerated: "The payment link was not generated. Please try again.",
        paymentVerification: "Payment Verification",
        paymentVerificationDesc: "Your star payment is being verified",
        paymentSent: "Payment Sent",
        paymentSentDesc: "USDT has been sent to your wallet",
        invalidAmount: "The payment amount must be a valid number greater than 0.",
        preparingTransaction: "Preparing your transaction",

        // Stars and Premium
        buyStars: "Buy Stars",
        sellStars: "Sell Stars",
        telegramPremium: "Telegram Premium",
        "3monthsPremium": "3 Months Premium",
        "3monthsDesc": "Unlock premium features for 3 months",
        "6monthsPremium": "6 Months Premium",
        "6monthsDesc": "Unlock premium features for 6 months",
        "12monthsPremium": "12 Months Premium",
        "12monthsDesc": "Unlock premium features for 12 months",
        buyNow: "Buy Now",
        buy: "Buy",
        buygift: "Buy Gift",
        buyFor: "Buy For",
        myself: "Myself",
        someoneElse: "Someone else",
        recipients: "Recipients (up to 5)",
        addRecipient: "Add Recipient",
        customStars: "Custom Stars",
        chooseStarsPackage: "Choose a Stars Package",
        sellNow: "Sell Now",
        currentRate: "Current Rate",
        updatedAgo: "Updated 8m ago",
        amountToSell: "Amount of Stars to Sell",
        youWillReceive: "You'll Receive (USDT)",
        stars: "Stars",
        amount: "Amount",
        toBeReceived: "To be received",

        // Orders and Transactions
        orderCreated: "Your order has been successfully created.",
        orderFailed: "Failed to create order. Please contact support.",
        orderError: "There was an error placing your order. Please try again.",
        transactionFailed: "The transaction could not be completed. Please try again.",
        transactionDetails: "Transaction Details",
        transactionID: "Transaction ID:",
        currentStatus: "Current Status",
        estimatedCompletion: "Estimated Completion",
        orderCreatedDesc: "Your order has been successfully created",
        transactionTimeline: "Transaction Timeline",
        processing: "Processing",
        processingDesc: "Your payment is being processed",
        recentTransactions: "Recent Transactions",
        noTransactions: "No transactions yet",
        errorLoadingTransactions: "Error loading transactions",
        transactionList: "Transaction List",
        walletError: "Wallet Error",
        failedToLoadNotifications: "Failed to load notifications",
        transactionCancelled: "Transaction was cancelled",
        transaction_details: "Transaction Details",
        referral_details: "Referral Details",
        days_ago: "days ago",
        importantNotice: "Important Notice",
        noticeText: "Please note that we will hold your Stars for a mandatory 21-day period before processing a payout. This period is required for security verification and compliance purposes. By clicking \"Continue\", you acknowledge and agree to these terms.",
        continue: "Continue",
        enterManualAddress: "Enter Manual Address",
        enterWalletAddress: "Enter USDT TON wallet address",
        memoTag: "Memo/Tag (if required)",
        memoNote: "Only required for certain exchanges like Binance, OKX",
        chooseRecommendedWallets: "Or Choose Recommended Wallets",
        minimumSell: "Minimum sell: 50 Stars",
        enterStars: "Enter stars (min 50)",
        enterMemoTag: "Enter memo/tag if required",
        enterRequiredMemo: "Enter required memo/tag",
        enterValidWalletAddress: "Please enter a valid wallet address (minimum 10 characters)",
        amountToSell: "Amount of Stars to Sell",
        youWillReceive: "You'll Receive (USDT)",
        sellNow: "Sell Now",
        howItWorks: "How it works:",
        step1Sell: "Enter the amount of stars you want to sell",
        step2Sell: "Click \"Sell Now\" to initiate the transaction",
        step3Sell: "Send the stars via Telegram payment",
        step4Sell: "Once verified, USDT will be sent to your wallet within 21 days",
        recentTransactions: "Recent Transactions",
        transactionHistory: "Transaction History",

        // How it works
        howItWorks: "How it works:",
        step1: "Enter the amount of stars you want to sell",
        step2: "Click \"Sell Now\" to initiate the transaction",
        step3: "Send the stars via Telegram payment",
        step4: "Once verified, USDT will be sent to your wallet within 21 days",

        // Referral System
        referralTitle: "Referral Program",
        referralSubtitle: "Invite friends and earn rewards",
        availableBalance: "Available Balance",
        withdraw: "Withdraw",
        totalEarned: "Total Earned",
        referrals: "Referrals",
        pending: "Pending",
        yourLink: "Your Referral Link",
        shareText: "Share this link with friends and earn 0.5 USDT for every successful referral",
        shareFb: "Share on Facebook",
        shareTw: "Share on Twitter",
        shareWa: "Share on WhatsApp",
        shareTg: "Share on Telegram",
        shareTwText: "Check out StarStore! Use my referral link to get started:",
        shareWaText: "Check out StarStore! Use my referral link to get started:",
        shareTgText: "Check out StarStore! Use my referral link to get started:",
        referralInfo: "You will earn 0.5 USDT for each successful referral. Earnings can be withdrawn to your TON wallet.",
        myReferrals: "My Referrals",
        withdrawals: "Withdrawals",
        noReferrals: "You don't have any referrals yet",
        shareInvite: "Share your referral link to invite friends",
        completed: "Completed",
        noWithdrawals: "No withdrawal history",
        startEarning: "Start earning by inviting friends",
        howItWorksReferral: "How it works",
        step1Title: "Share your link",
        step1Desc: "Copy your unique referral link and share it with friends",
        step2Title: "Friends make a purchase",
        step2Desc: "They get instant access to Premium or Stars",
        step3Title: "You earn rewards",
        step3Desc: "Get 0.5 USDT for each successful referral",
        step4Title: "Withdraw earnings",
        step4Desc: "Transfer funds to your TON wallet when ready",
        withdrawTitle: "Withdraw Funds",
        withdrawDesc: "Transfer your earnings to your TON wallet",
        amount: "Amount (USDT)",
        walletAddress: "TON Wallet Address",
        submitWithdrawal: "Submit Withdrawal",
        linkCopied: "Link copied to clipboard!",
        minWithdraw: "Minimum withdrawal is 0.5 USDT",
        maxWithdraw: "Maximum withdrawal is",
        invalidWallet: "Invalid TON wallet address",
        withdrawSuccessTitle: "Success!",
        withdrawSuccessText: "Withdrawal of",
        requested: "requested",
        withdrawError: "Withdrawal failed",
        insufficientBalanceTitle: "Insufficient Balance",
        insufficientBalanceText: "You need at least 1 completed referral (0.5 USDT) to withdraw.",
        yourBalance: "Your balance:",

        // Notifications
        noNotifications: "No new notifications",
        notifications: "Notifications",
        markAllRead: "Mark All Read",
        markAsRead: "Mark as Read",
        unread: "Unread",
        allNotifications: "All Notifications",
        loadingNotifications: "Loading notifications...",
        notificationsError: "Failed to load notifications",
        notificationsNotAvailable: "Notifications service not available",
        telegramRequiredForNotifications: "Please open in Telegram to view notifications",
        tryInTelegram: "Try opening in Telegram for full functionality",

        // About Page
        aboutTitle: "About StarStore",
        aboutSubtitle: "Your trusted platform for Telegram Stars and Premium",
        aboutDescription: "StarStore is a secure and reliable platform for purchasing Telegram Stars and Premium subscriptions. We provide fast, secure, and convenient payment processing with excellent customer support.",
        features: "Features",
        securePayments: "Secure Payments",
        securePaymentsDesc: "All transactions are secured with Telegram's payment system",
        instantDelivery: "Instant Delivery",
        instantDeliveryDesc: "Receive your Stars and Premium instantly after payment",
        customerSupport: "Customer Support",
        customerSupportDesc: "24/7 customer support to help you with any issues",
        competitiveRates: "Competitive Rates",
        competitiveRatesDesc: "Best rates in the market for Telegram Stars and Premium",
        contactUs: "Contact Us",
        contactUsDesc: "Get in touch with our support team",
        telegramBot: "Telegram Bot",
        telegramBotDesc: "Chat with our bot for instant support",
        emailSupport: "Email Support",
        emailSupportDesc: "Send us an email for detailed assistance",
        language: "Language",
        english: "English",
        russian: "Russian",
        
        // Additional keys used in pages
        welcome: "Welcome to",
        tagline: "Your trusted platform for Telegram Premium and Stars",
        mission: "Our Mission",
        missionText: "We aim to provide a seamless and secure platform for Telegram users to enhance their experience through premium features and star purchases. Our commitment is to deliver exceptional service while maintaining transparency and trust.",
        keyFeatures: "Key Features",
        secure: "Secure Transactions",
        secureText: "Your payments are protected with TON blockchain technology",
        instant: "Instant Delivery",
        instantText: "Receive your purchases immediately after payment confirmation",
        support: "24/7 Support",
        supportText: "Our team is always ready to assist you with any questions",
        impact: "Our Impact",
        users: "Active Users",
        success: "Success Rate",
        rating: "User Rating",
        getInTouch: "Get in Touch",
        getInTouchText: "Have questions or need support? Our team is here to help! We provide 24/7 assistance for all your StarStore needs.",
        contactText: "Have questions or need support? Our team is here to help! We provide 24/7 assistance for all your StarStore needs.",
        contactSupport: "Contact Support",
        contactBtn: "Contact Support",
        footerPowered: "Powered by",
        
        // Notification page specific
        notifications: "Notifications",
        markAllRead: "Mark All Read",
        refresh: "Refresh",
        loadingNotifications: "Loading notifications...",
        noNotificationsYet: "No notifications yet",
        notificationEmptyDesc: "We'll notify you about important updates and activities",
        unread: "unread",
        loadMore: "Load More",
        
        // Error messages
        quoteError: "Unable to get quote. Please try again.",
        quoteUnavailable: "Quote unavailable. Please try again.",
        validationError: "Validation failed. Please try again.",
        
        // History page specific
        overview: "Overview",
        all: "All",
        searchTransactions: "Search transactions...",
        searchReferrals: "Search referrals...",
        noTransactions: "No transactions found",
        noReferrals: "No referrals found",
        exportTransactions: "Export Transactions",
        exportReferrals: "Export Referrals",
        transactionDetails: "Transaction Details",
        referralDetails: "Referral Details",
        id: "ID",
        type: "Type",
        name: "Name",
        total: "Total",

        // Error Messages
        initializationError: "Failed to initialize application",
        telegramInitError: "Telegram initialization failed. Running in limited mode.",
        userNotFound: "User information not found. Please refresh the page and try again.",
        missingWalletAddress: "Missing Wallet Address",
        enterValidWallet: "Please enter a valid wallet address to proceed.",
        walletConnectMessage: "Please connect your wallet or enter a wallet address manually to proceed.",

        // Status Messages
        status: "Status",
        pending: "Pending",
        processing: "Processing",
        completed: "Completed",
        failed: "Failed",
        cancelled: "Cancelled",
        declined: "Declined",
        expired: "Expired",

        // Time and Date
        today: "Today",
        yesterday: "Yesterday",
        daysAgo: "days ago",
        hoursAgo: "hours ago",
        minutesAgo: "minutes ago",
        justNow: "Just now",

        // Currency
        usdt: "USDT",
        currency: "Currency",

        // Actions
        viewDetails: "View Details",
        download: "Download",
        upload: "Upload",
        select: "Select",
        choose: "Choose",
        add: "Add",
        remove: "Remove",
        update: "Update",
        create: "Create",
        send: "Send",
        receive: "Receive",
        transfer: "Transfer",
        withdraw: "Withdraw",
        deposit: "Deposit",
        exchange: "Exchange",
        convert: "Convert",

        // Validation Messages
        required: "This field is required",
        invalidEmail: "Please enter a valid email address",
        invalidPhone: "Please enter a valid phone number",
        invalidAmount: "Please enter a valid amount",
        minLength: "Minimum length is {0} characters",
        maxLength: "Maximum length is {0} characters",
        passwordMismatch: "Passwords do not match",
        invalidFormat: "Invalid format",
        tooShort: "Too short",
        tooLong: "Too long",
        invalidInput: "Invalid input",

        // Success Messages
        saved: "Saved successfully",
        updated: "Updated successfully",
        deleted: "Deleted successfully",
        created: "Created successfully",
        sent: "Sent successfully",
        received: "Received successfully",
        connected: "Connected successfully",
        disconnected: "Disconnected successfully",

        // Error Messages
        somethingWentWrong: "Something went wrong",
        tryAgain: "Please try again",
        contactSupport: "Please contact support",
        networkError: "Network error",
        serverError: "Server error",
        timeoutError: "Request timeout",
        unauthorized: "Unauthorized access",
        forbidden: "Access forbidden",
        notFound: "Not found",
        internalError: "Internal server error",
        serviceUnavailable: "Service unavailable"
    },
    ru: {
        // Common UI elements
        appName: "StarStore",
        menu: "Меню",
        home: "Главная",
        sell: "Продать",
        history: "История",
        referral: "Реферальная программа",
        about: "О нас",
        error: "Ошибка",
        success: "Успешно",
        ok: "ОК",
        warning: "Предупреждение",
        continue: "Продолжить",
        cancel: "Отмена",
        loading: "Загрузка...",
        processing: "Обработка...",
        loadingTransactionDetails: "Загрузка деталей транзакции...",
        connectingToSupport: "Подключение к поддержке StarStore...",
        important: "Важно:",
        doubleCheckWallet: "Дважды проверьте адрес кошелька. Платежи не могут быть отменены после отправки.",
        paymentConfirmation: "Подтверждение платежа",
        aboutToSell: "Вы собираетесь продать",
        starsFor: "звезд за",
        pleaseConfirmTransaction: "Пожалуйста, подтвердите эту транзакцию через Telegram.",
        transactionDetails: "Детали транзакции",
        amount: "Количество",
        toBeReceived: "К получению",
        currentStatus: "Текущий статус",
        estimatedCompletion: "Ожидаемое завершение",
        progress: "Прогресс",
        estCompletion: "Ожид. завершение:",
        buy: "Купить",
        starsDistribution: "Распределение звезд:",
        ifSetOverrides: "Если установлено, это переопределяет выбор пакета.",
        enterTelegramUsernames: "Введите Telegram имена пользователей.",
        maximumRecipientsAllowed: "Максимум 5 получателей разрешено",
        needAtLeastStars: "Нужно минимум {stars} звезд для {count} получателей (50 звезд минимум каждый)",
        accessDenied: "Доступ запрещен",
        lookLikeLost: "Похоже, вы заблудились",
        pageNotAvailable: "страница, которую вы ищете, недоступна!",
        goToHome: "Перейти на главную",
        save: "Сохранить",
        edit: "Изменить",
        delete: "Удалить",
        close: "Закрыть",
        back: "Назад",
        next: "Далее",
        previous: "Предыдущий",
        submit: "Отправить",
        confirm: "Подтвердить",
        yes: "Да",
        no: "Нет",
        retry: "Повторить",
        refresh: "Обновить",
        copy: "Копировать",
        share: "Поделиться",
        search: "Поиск",
        filter: "Фильтр",
        sort: "Сортировка",
        view: "Просмотр",
        details: "Детали",
        settings: "Настройки",
        help: "Помощь",
        support: "Поддержка",
        contact: "Контакты",
        terms: "Условия использования",
        privacy: "Политика конфиденциальности",
        poweredBy: "Работает на",

        // Wallet and Payment
        connectWallet: "Подключить кошелек",
        walletNotConnected: "Пожалуйста, подключите кошелек, чтобы продолжить.",
        walletConnected: "Кошелек подключен",
        walletAddress: "Адрес кошелька",
        enterManually: "Ввести адрес кошелька вручную",
        editAddress: "Изменить адрес",
        saveAddress: "Сохранить адрес",
        paymentInfo: "Платежи будут отправлены на выбранный кошелек.",
        paymentFailed: "Оплата не удалась. Пожалуйста, попробуйте позже.",
        paymentSuccessful: "Оплата выполнена успешно!",
        paymentProcessed: "Ваш платеж был успешно обработан.",
        paymentInitiated: "Платеж инициирован!",
        completePayment: "Пожалуйста, завершите платеж в Telegram.",
        paymentNotSuccessful: "Ваш платеж не был успешным. Пожалуйста, попробуйте снова.",
        paymentLinkMissing: "Ссылка на оплату отсутствует",
        paymentLinkNotGenerated: "Ссылка на оплату не была сгенерирована. Пожалуйста, попробуйте снова.",
        paymentVerification: "Проверка платежа",
        paymentVerificationDesc: "Ваш платеж звездами проверяется",
        paymentSent: "Платеж отправлен",
        paymentSentDesc: "USDT отправлен на ваш кошелек",
        invalidAmount: "Сумма платежа должна быть действительным числом больше 0.",
        preparingTransaction: "Подготовка вашей транзакции",

        // Stars and Premium
        buyStars: "Купить звезды",
        sellStars: "Продать звезды",
        telegramPremium: "Telegram Премиум",
        "3monthsPremium": "3 Месяца Премиум",
        "3monthsDesc": "Разблокируйте премиум-функции на 3 месяца",
        "6monthsPremium": "6 Месяцев Премиум",
        "6monthsDesc": "Разблокируйте премиум-функции на 6 месяцев",
        "12monthsPremium": "12 Месяцев Премиум",
        "12monthsDesc": "Разблокируйте премиум-функции на 12 месяцев",
        buyNow: "Купить сейчас",
        buy: "Купить",
        buygift: "Купить подарок",
        buyFor: "Купить для",
        myself: "Себе",
        someoneElse: "Кому-то другому",
        recipients: "Получатели (до 5)",
        addRecipient: "Добавить получателя",
        customStars: "Пользовательские звезды",
        chooseStarsPackage: "Выберите пакет звезд",
        sellNow: "Продать сейчас",
        currentRate: "Текущий курс",
        updatedAgo: "Обновлено 8м назад",
        amountToSell: "Количество звезд для продажи",
        youWillReceive: "Вы получите (USDT)",
        stars: "Звезды",
        amount: "Количество",
        toBeReceived: "К получению",

        // Orders and Transactions
        orderCreated: "Ваш заказ успешно создан.",
        orderFailed: "Не удалось создать заказ. Пожалуйста, обратитесь в поддержку.",
        orderError: "При размещении вашего заказа произошла ошибка. Пожалуйста, попробуйте снова.",
        transactionFailed: "Транзакция не удалась. Пожалуйста, попробуйте еще раз.",
        transactionDetails: "Детали транзакции",
        transactionID: "ID транзакции:",
        currentStatus: "Текущий статус",
        estimatedCompletion: "Ожидаемое завершение",
        orderCreatedDesc: "Ваш заказ успешно создан",
        transactionTimeline: "Временная шкала транзакции",
        processing: "Обработка",
        processingDesc: "Ваш платеж обрабатывается",
        recentTransactions: "Недавние транзакции",
        noTransactions: "Пока нет транзакций",
        errorLoadingTransactions: "Ошибка загрузки транзакций",
        transactionList: "Список транзакций",
        walletError: "Ошибка кошелька",
        failedToLoadNotifications: "Не удалось загрузить уведомления",
        transactionCancelled: "Транзакция была отменена",
        transaction_details: "Детали транзакции",
        referral_details: "Детали реферала",
        days_ago: "дней назад",
        importantNotice: "Важное уведомление",
        noticeText: "Обратите внимание, что мы будем хранить ваши Stars в течение обязательного 21-дневного периода перед обработкой выплаты. Этот период необходим для проверки безопасности и соблюдения требований. Нажимая \"Продолжить\", вы подтверждаете и соглашаетесь с этими условиями.",
        continue: "Продолжить",
        enterManualAddress: "Ввести адрес вручную",
        enterWalletAddress: "Введите адрес USDT TON кошелька",
        memoTag: "Мемо/Тег (если требуется)",
        memoNote: "Требуется только для определенных бирж, таких как Binance, OKX",
        chooseRecommendedWallets: "Или выберите рекомендуемые кошельки",
        minimumSell: "Минимальная продажа: 50 Stars",
        enterStars: "Введите звезды (мин. 50)",
        enterMemoTag: "Введите мемо/тег, если требуется",
        enterRequiredMemo: "Введите требуемый мемо/тег",
        enterValidWalletAddress: "Пожалуйста, введите действительный адрес кошелька (минимум 10 символов)",
        amountToSell: "Количество Stars для продажи",
        youWillReceive: "Вы получите (USDT)",
        sellNow: "Продать сейчас",
        howItWorks: "Как это работает:",
        step1Sell: "Введите количество звезд, которые вы хотите продать",
        step2Sell: "Нажмите \"Продать сейчас\", чтобы инициировать транзакцию",
        step3Sell: "Отправьте звезды через платеж Telegram",
        step4Sell: "После проверки, USDT будет отправлен на ваш кошелек в течение 21 дня",
        recentTransactions: "Недавние транзакции",
        transactionHistory: "История транзакций",

        // How it works
        howItWorks: "Как это работает:",
        step1: "Введите количество звезд, которые вы хотите продать",
        step2: "Нажмите \"Продать сейчас\", чтобы инициировать транзакцию",
        step3: "Отправьте звезды через платеж Telegram",
        step4: "После проверки, USDT будет отправлен на ваш кошелек в течение 21 дня",

        // Referral System
        referralTitle: "Реферальная программа",
        referralSubtitle: "Приглашайте друзей и получайте вознаграждения",
        availableBalance: "Доступный баланс",
        withdraw: "Вывести",
        totalEarned: "Всего заработано",
        referrals: "Рефералы",
        pending: "В ожидании",
        yourLink: "Ваша реферальная ссылка",
        shareText: "Поделитесь этой ссылкой с друзьями и получите 0.5 USDT за каждого успешного реферала",
        shareFb: "Поделиться в Facebook",
        shareTw: "Поделиться в Twitter",
        shareWa: "Поделиться в WhatsApp",
        shareTg: "Поделиться в Telegram",
        shareTwText: "Попробуйте StarStore! Используйте мою реферальную ссылку:",
        shareWaText: "Попробуйте StarStore! Используйте мою реферальную ссылку:",
        shareTgText: "Попробуйте StarStore! Используйте мою реферальную ссылку:",
        referralInfo: "Вы заработаете 0.5 USDT за каждого успешного реферала. Заработок можно вывести на ваш TON кошелек.",
        myReferrals: "Мои рефералы",
        withdrawals: "Выводы",
        noReferrals: "У вас пока нет рефералов",
        shareInvite: "Поделитесь своей реферальной ссылкой, чтобы пригласить друзей",
        completed: "Завершено",
        noWithdrawals: "История выводов пуста",
        startEarning: "Начните зарабатывать, приглашая друзей",
        howItWorksReferral: "Как это работает",
        step1Title: "Поделитесь своей ссылкой",
        step1Desc: "Скопируйте уникальную реферальную ссылку и поделитесь ею с друзьями",
        step2Title: "Друзья совершают покупку",
        step2Desc: "Они получают мгновенный доступ к Premium или Stars",
        step3Title: "Вы получаете вознаграждение",
        step3Desc: "Получите 0.5 USDT за каждого успешного реферала",
        step4Title: "Выведите заработок",
        step4Desc: "Переведите средства на свой TON кошелек, когда будете готовы",
        withdrawTitle: "Вывод средств",
        withdrawDesc: "Перевод заработка на ваш TON кошелек",
        amount: "Сумма (USDT)",
        walletAddress: "Адрес TON кошелька",
        submitWithdrawal: "Отправить запрос на вывод",
        linkCopied: "Ссылка скопирована в буфер обмена!",
        minWithdraw: "Минимальная сумма вывода 0.5 USDT",
        maxWithdraw: "Максимальная сумма вывода",
        invalidWallet: "Неверный адрес TON кошелька",
        withdrawSuccessTitle: "Успешно!",
        withdrawSuccessText: "Запрос на вывод",
        requested: "отправлен",
        withdrawError: "Ошибка при выводе средств",
        insufficientBalanceTitle: "Недостаточно средств",
        insufficientBalanceText: "Для вывода требуется хотя бы 1 завершенный реферал (0.5 USDT).",
        yourBalance: "Ваш баланс:",

        // Notifications
        noNotifications: "Нет новых уведомлений",
        notifications: "Уведомления",
        markAllRead: "Отметить все как прочитанные",
        markAsRead: "Отметить как прочитанное",
        unread: "Непрочитанные",
        allNotifications: "Все уведомления",
        loadingNotifications: "Загрузка уведомлений...",
        notificationsError: "Не удалось загрузить уведомления",
        notificationsNotAvailable: "Сервис уведомлений недоступен",
        telegramRequiredForNotifications: "Откройте в Telegram для просмотра уведомлений",
        tryInTelegram: "Попробуйте открыть в Telegram для полного функционала",

        // About Page
        aboutTitle: "О StarStore",
        aboutSubtitle: "Ваша надежная платформа для Telegram Stars и Premium",
        aboutDescription: "StarStore - это безопасная и надежная платформа для покупки Telegram Stars и Premium подписок. Мы обеспечиваем быструю, безопасную и удобную обработку платежей с отличной поддержкой клиентов.",
        features: "Возможности",
        securePayments: "Безопасные платежи",
        securePaymentsDesc: "Все транзакции защищены платежной системой Telegram",
        instantDelivery: "Мгновенная доставка",
        instantDeliveryDesc: "Получите свои Stars и Premium мгновенно после оплаты",
        customerSupport: "Поддержка клиентов",
        customerSupportDesc: "24/7 поддержка клиентов для решения любых вопросов",
        competitiveRates: "Конкурентные цены",
        competitiveRatesDesc: "Лучшие цены на рынке для Telegram Stars и Premium",
        contactUs: "Свяжитесь с нами",
        contactUsDesc: "Свяжитесь с нашей службой поддержки",
        telegramBot: "Telegram бот",
        telegramBotDesc: "Чат с нашим ботом для мгновенной поддержки",
        emailSupport: "Email поддержка",
        emailSupportDesc: "Отправьте нам email для подробной помощи",
        language: "Язык",
        english: "Английский",
        russian: "Русский",
        
        // Additional keys used in pages
        welcome: "Добро пожаловать в",
        tagline: "Ваша надежная платформа для Telegram Premium и Звезд",
        mission: "Наша миссия",
        missionText: "Мы стремимся предоставить безупречную и безопасную платформу для пользователей Telegram, чтобы улучшить их опыт использования с помощью премиум-функций и покупки звезд. Наше обязательство — обеспечить исключительный сервис, сохраняя прозрачность и доверие.",
        keyFeatures: "Ключевые особенности",
        secure: "Безопасные транзакции",
        secureText: "Ваши платежи защищены технологией блокчейна TON",
        instant: "Мгновенная доставка",
        instantText: "Получайте свои покупки сразу после подтверждения оплаты",
        support: "Поддержка 24/7",
        supportText: "Наша команда всегда готова помочь вам с любыми вопросами",
        impact: "Наше влияние",
        users: "Активных пользователей",
        success: "Успешных операций",
        rating: "Рейтинг пользователей",
        getInTouch: "Свяжитесь с нами",
        getInTouchText: "Есть вопросы или нужна поддержка? Наша команда здесь, чтобы помочь! Мы предоставляем круглосуточную помощь для всех ваших потребностей в StarStore.",
        contactText: "Есть вопросы или нужна поддержка? Наша команда здесь, чтобы помочь! Мы предоставляем круглосуточную помощь для всех ваших потребностей в StarStore.",
        contactSupport: "Связаться с поддержкой",
        contactBtn: "Связаться с поддержкой",
        footerPowered: "Работает на",
        
        // Notification page specific
        notifications: "Уведомления",
        markAllRead: "Отметить все как прочитанные",
        refresh: "Обновить",
        loadingNotifications: "Загрузка уведомлений...",
        noNotificationsYet: "Пока нет уведомлений",
        notificationEmptyDesc: "Мы будем уведомлять вас о важных обновлениях и действиях",
        unread: "непрочитанных",
        loadMore: "Загрузить еще",
        
        // Error messages
        quoteError: "Не удалось получить котировку. Попробуйте еще раз.",
        quoteUnavailable: "Котировка недоступна. Попробуйте еще раз.",
        validationError: "Ошибка валидации. Попробуйте еще раз.",
        
        // History page specific
        overview: "Обзор",
        all: "Все",
        searchTransactions: "Поиск транзакций...",
        searchReferrals: "Поиск рефералов...",
        noTransactions: "Транзакций не найдено",
        noReferrals: "Рефералов не найдено",
        exportTransactions: "Экспорт транзакций",
        exportReferrals: "Экспорт рефералов",
        transactionDetails: "Детали транзакции",
        referralDetails: "Детали реферала",
        id: "ID",
        type: "Тип",
        name: "Имя",
        total: "Всего",

        // Error Messages
        initializationError: "Ошибка инициализации приложения",
        telegramInitError: "Ошибка инициализации Telegram. Работа в ограниченном режиме.",
        userNotFound: "Информация о пользователе не найдена. Пожалуйста, обновите страницу и попробуйте снова.",
        missingWalletAddress: "Отсутствует адрес кошелька",
        enterValidWallet: "Пожалуйста, введите действительный адрес кошелька, чтобы продолжить.",
        walletConnectMessage: "Пожалуйста, подключите кошелек или введите адрес кошелька вручную, чтобы продолжить.",

        // Status Messages
        status: "Статус",
        pending: "В ожидании",
        processing: "Обработка",
        completed: "Завершено",
        failed: "Не удалось",
        cancelled: "Отменено",
        declined: "Отклонено",
        expired: "Истекло",

        // Time and Date
        today: "Сегодня",
        yesterday: "Вчера",
        daysAgo: "дней назад",
        hoursAgo: "часов назад",
        minutesAgo: "минут назад",
        justNow: "Только что",

        // Currency
        usdt: "USDT",
        currency: "Валюта",

        // Actions
        viewDetails: "Просмотр деталей",
        download: "Скачать",
        upload: "Загрузить",
        select: "Выбрать",
        choose: "Выбрать",
        add: "Добавить",
        remove: "Удалить",
        update: "Обновить",
        create: "Создать",
        send: "Отправить",
        receive: "Получить",
        transfer: "Перевести",
        withdraw: "Вывести",
        deposit: "Пополнить",
        exchange: "Обменять",
        convert: "Конвертировать",

        // Validation Messages
        required: "Это поле обязательно для заполнения",
        invalidEmail: "Пожалуйста, введите действительный email адрес",
        invalidPhone: "Пожалуйста, введите действительный номер телефона",
        invalidAmount: "Пожалуйста, введите действительную сумму",
        minLength: "Минимальная длина {0} символов",
        maxLength: "Максимальная длина {0} символов",
        passwordMismatch: "Пароли не совпадают",
        invalidFormat: "Неверный формат",
        tooShort: "Слишком короткий",
        tooLong: "Слишком длинный",
        invalidInput: "Неверный ввод",

        // Success Messages
        saved: "Успешно сохранено",
        updated: "Успешно обновлено",
        deleted: "Успешно удалено",
        created: "Успешно создано",
        sent: "Успешно отправлено",
        received: "Успешно получено",
        connected: "Успешно подключено",
        disconnected: "Успешно отключено",

        // Error Messages
        somethingWentWrong: "Что-то пошло не так",
        tryAgain: "Пожалуйста, попробуйте снова",
        contactSupport: "Пожалуйста, обратитесь в поддержку",
        networkError: "Ошибка сети",
        serverError: "Ошибка сервера",
        timeoutError: "Таймаут запроса",
        unauthorized: "Неавторизованный доступ",
        forbidden: "Доступ запрещен",
        notFound: "Не найдено",
        internalError: "Внутренняя ошибка сервера",
        serviceUnavailable: "Сервис недоступен"
    }
};

// Translation utility functions
const TranslationUtils = {
    // Get current language
    getCurrentLanguage() {
        return localStorage.getItem('appLanguage') || 'en';
    },

    // Set current language
    setCurrentLanguage(language) {
        localStorage.setItem('appLanguage', language);
        this.applyTranslations();
    },

    // Get translation for a key
    get(key, language = null) {
        const currentLang = language || this.getCurrentLanguage();
        const langTranslations = translations[currentLang];
        
        if (!langTranslations) {
            console.warn(`Language '${currentLang}' not found, falling back to 'en'`);
            return translations.en[key] || key;
        }
        
        return langTranslations[key] || translations.en[key] || key;
    },

    // Apply translations to all elements with data-translate attribute
    applyTranslations() {
        const currentLang = this.getCurrentLanguage();
        
        document.querySelectorAll('[data-translate]').forEach(element => {
            const key = element.getAttribute('data-translate');
            const translation = this.get(key, currentLang);
            
            if (translation) {
                element.textContent = translation;
            }
        });

        // Apply placeholder translations
        document.querySelectorAll('[data-translate-placeholder]').forEach(element => {
            const key = element.getAttribute('data-translate-placeholder');
            const translation = this.get(key, currentLang);
            
            if (translation) {
                element.placeholder = translation;
            }
        });

        // Update language buttons
        document.querySelectorAll('.language-btn').forEach(btn => {
            const btnLang = btn.getAttribute('data-language');
            btn.classList.toggle('active', btnLang === currentLang);
        });
    },

    // Format translation with parameters
    format(key, ...params) {
        let translation = this.get(key);
        
        // Handle both indexed and named placeholders
        if (params.length === 1 && typeof params[0] === 'object') {
            // Named placeholders: format(key, {stars: 100, count: 2})
            const namedParams = params[0];
            Object.keys(namedParams).forEach(paramName => {
                translation = translation.replace(new RegExp(`{${paramName}}`, 'g'), namedParams[paramName]);
            });
        } else {
            // Indexed placeholders: format(key, param1, param2)
            params.forEach((param, index) => {
                translation = translation.replace(new RegExp(`{${index}}`, 'g'), param);
            });
        }
        
        return translation;
    },

    // Initialize translation system
    init() {
        this.applyTranslations();
        
        // Add event listeners for language switching
        document.querySelectorAll('.language-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const language = btn.getAttribute('data-language');
                this.setCurrentLanguage(language);
            });
        });
    }
};

// Auto-initialize when DOM is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        TranslationUtils.init();
    });
} else {
    TranslationUtils.init();
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { translations, TranslationUtils };
}