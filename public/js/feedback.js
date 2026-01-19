/**
 * Feedback System - Complete Client-Side Handler
 * Manages form submission, file uploads, validation, and user interaction
 */

class FeedbackSystem {
    constructor() {
        this.selectedType = null;
        this.attachedFiles = [];
        this.maxTotalSize = 20 * 1024 * 1024; // 20MB
        this.maxFileSize = 10 * 1024 * 1024; // 10MB per file
        this.currentTotalSize = 0;
        this.userId = null;
        this.init();
    }

    /**
     * Initialize the feedback system
     */
    init() {
        this.setupTelegramWebApp();
        this.setupEventListeners();
        this.setupDragDrop();
        this.setupCharacterCounter();
        this.loadUserInfo();
        this.setupTranslations();
    }

    /**
     * Initialize Telegram WebApp
     */
    setupTelegramWebApp() {
        try {
            if (window.Telegram?.WebApp) {
                const webApp = window.Telegram.WebApp;
                webApp.ready();
                webApp.expand();
                document.body.classList.add('telegram-fullscreen');
            }
        } catch (e) {
            console.log('Not in Telegram WebApp context');
        }
    }

    /**
     * Setup all event listeners
     */
    setupEventListeners() {
        // Exit button
        const exitButton = document.getElementById('exitButton');
        if (exitButton) {
            exitButton.addEventListener('click', () => {
                if (window.history.length > 1) {
                    window.history.back();
                } else {
                    window.location.href = '/';
                }
            });
        }

        // Feedback type selection
        document.querySelectorAll('.feedback-type').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.selectFeedbackType(btn);
            });
        });

        // Media upload click
        const mediaUploadSection = document.getElementById('mediaUploadSection');
        if (mediaUploadSection) {
            mediaUploadSection.addEventListener('click', () => {
                document.getElementById('mediaInput').click();
            });
        }

        // Media input change
        const mediaInput = document.getElementById('mediaInput');
        if (mediaInput) {
            mediaInput.addEventListener('change', (e) => this.handleMediaSelect(e.target.files));
        }

        // Form submission
        const form = document.getElementById('feedbackForm');
        if (form) {
            form.addEventListener('submit', (e) => this.handleSubmit(e));
        }

        // Load bottom navigation
        this.loadBottomNav();
    }

    /**
     * Select feedback type
     */
    selectFeedbackType(button) {
        // Remove active class from all buttons
        document.querySelectorAll('.feedback-type').forEach(btn => {
            btn.classList.remove('active');
        });

        // Add active class to selected button
        button.classList.add('active');

        // Store the selected type
        this.selectedType = button.getAttribute('data-type');
        document.getElementById('feedbackType').value = this.selectedType;
    }

    /**
     * Setup drag and drop functionality
     */
    setupDragDrop() {
        const mediaUploadSection = document.getElementById('mediaUploadSection');
        if (!mediaUploadSection) return;

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            mediaUploadSection.addEventListener(eventName, this.preventDefaults.bind(this), false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            mediaUploadSection.addEventListener(eventName, () => {
                mediaUploadSection.classList.add('drag-over');
            }, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            mediaUploadSection.addEventListener(eventName, () => {
                mediaUploadSection.classList.remove('drag-over');
            }, false);
        });

        mediaUploadSection.addEventListener('drop', (e) => {
            this.handleMediaSelect(e.dataTransfer.files);
        }, false);
    }

    /**
     * Prevent default drag and drop behavior
     */
    preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    /**
     * Handle media file selection
     */
    handleMediaSelect(files) {
        const validFiles = [];
        const errors = [];

        for (let file of files) {
            // Check file type
            if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
                errors.push(`${file.name}: ${this.translate('invalidFileType')}`);
                continue;
            }

            // Check file size
            if (file.size > this.maxFileSize) {
                errors.push(`${file.name}: ${this.translate('fileTooLarge')} (${this.formatFileSize(file.size)} > 10MB)`);
                continue;
            }

            // Check total size
            if (this.currentTotalSize + file.size > this.maxTotalSize) {
                errors.push(`${this.translate('totalSizeExceeded')} (${this.formatFileSize(this.maxTotalSize)})`);
                break;
            }

            validFiles.push(file);
            this.currentTotalSize += file.size;
        }

        // Show errors if any
        if (errors.length > 0) {
            this.showError(errors.join('\n'));
        }

        // Add valid files
        if (validFiles.length > 0) {
            this.attachedFiles.push(...validFiles);
            this.renderMediaPreview();
            this.clearError();
        }
    }

    /**
     * Render media preview
     */
    renderMediaPreview() {
        const preview = document.getElementById('mediaPreview');
        preview.innerHTML = '';

        this.attachedFiles.forEach((file, index) => {
            const item = document.createElement('div');
            item.className = 'media-item';

            const isImage = file.type.startsWith('image/');
            const isVideo = file.type.startsWith('video/');

            if (isImage) {
                const img = document.createElement('img');
                img.src = URL.createObjectURL(file);
                item.appendChild(img);
            } else if (isVideo) {
                const video = document.createElement('video');
                video.src = URL.createObjectURL(file);
                item.appendChild(video);
            }

            // Remove button
            const removeBtn = document.createElement('div');
            removeBtn.className = 'media-remove';
            removeBtn.innerHTML = '×';
            removeBtn.addEventListener('click', () => this.removeMedia(index));
            item.appendChild(removeBtn);

            // Size info
            const sizeInfo = document.createElement('div');
            sizeInfo.className = 'media-size-info';
            sizeInfo.textContent = this.formatFileSize(file.size);

            const container = document.createElement('div');
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.alignItems = 'center';
            container.appendChild(item);
            container.appendChild(sizeInfo);

            preview.appendChild(container);
        });
    }

    /**
     * Remove media file
     */
    removeMedia(index) {
        const file = this.attachedFiles[index];
        this.currentTotalSize -= file.size;
        this.attachedFiles.splice(index, 1);
        this.renderMediaPreview();
    }

    /**
     * Setup character counter
     */
    setupCharacterCounter() {
        const textarea = document.getElementById('feedbackMessage');
        if (!textarea) return;

        textarea.addEventListener('input', () => {
            const count = textarea.value.length;
            const counter = document.getElementById('charCount');
            if (counter) {
                counter.textContent = count;

                // Update styling based on count
                const counterContainer = counter.parentElement;
                counterContainer.classList.remove('warning', 'max');

                if (count >= 2700) {
                    counterContainer.classList.add('warning');
                }
                if (count >= 3000) {
                    counterContainer.classList.add('max');
                }
            }
        });
    }

    /**
     * Load and display user information
     */
    loadUserInfo() {
        try {
            const user = window.Telegram?.WebApp?.initDataUnsafe?.user;
            this.userId = user?.id || 'Web User';

            // Display User ID
            const userIdDisplay = document.getElementById('displayUserId');
            if (userIdDisplay) {
                userIdDisplay.textContent = this.userId;
            }

            // Display timestamp
            const timestampDisplay = document.getElementById('displayTimestamp');
            if (timestampDisplay) {
                const now = new Date();
                timestampDisplay.textContent = now.toLocaleString();
            }
        } catch (e) {
            console.error('Error loading user info:', e.message);
            const userIdDisplay = document.getElementById('displayUserId');
            if (userIdDisplay) {
                userIdDisplay.textContent = 'Web User';
            }
        }
    }

    /**
     * Handle form submission
     */
    async handleSubmit(e) {
        e.preventDefault();
        console.log('Form submission started');

        // Validate form
        if (!this.selectedType) {
            const msg = this.translate('selectFeedbackType');
            console.warn('Validation failed: no feedback type selected');
            this.showError(msg);
            return;
        }

        const emailInput = document.getElementById('userEmail');
        const messageInput = document.getElementById('feedbackMessage');

        if (!emailInput.value.trim()) {
            const msg = this.translate('enterEmail');
            console.warn('Validation failed: empty email');
            this.showError(msg);
            return;
        }

        if (!messageInput.value.trim()) {
            const msg = this.translate('enterFeedback');
            console.warn('Validation failed: empty message');
            this.showError(msg);
            return;
        }

        // Disable submit button and show loading state
        const submitBtn = document.getElementById('submitBtn');
        if (!submitBtn) {
            console.error('Submit button not found');
            return;
        }
        
        submitBtn.disabled = true;
        submitBtn.classList.add('loading');
        submitBtn.innerHTML = '<div class="spinner"></div><span>' + this.translate('sending') + '</span>';

        try {
            console.log('Preparing form data...');
            // Create FormData for multipart submission
            const formData = new FormData();
            formData.append('userId', this.userId || 'web-user');
            formData.append('type', this.selectedType);
            formData.append('email', emailInput.value.trim());
            formData.append('message', messageInput.value.trim());
            formData.append('timestamp', new Date().toISOString());

            // Add attached files
            this.attachedFiles.forEach((file, index) => {
                formData.append(`media_${index}`, file);
            });

            console.log('Submitting feedback:', { type: this.selectedType, email: emailInput.value.trim().substring(0, 10) + '...', messageLength: messageInput.value.length });

            // Send feedback to backend with proper error handling
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
            
            const response = await fetch('/api/feedback/submit', {
                method: 'POST',
                body: formData,
                signal: controller.signal
            }).catch(err => {
                clearTimeout(timeoutId);
                if (err.name === 'AbortError') {
                    console.error('Request timeout after 30 seconds');
                    throw new Error('Request timeout. Please check your connection and try again.');
                }
                throw err;
            });

            clearTimeout(timeoutId);
            console.log('Response:', response.status);

            if (!response.ok) {
                let errorText = '';
                try {
                    errorText = await response.text();
                    console.error('Server error response:', errorText);
                    // Try to parse JSON error response for better messages
                    try {
                        const errorJson = JSON.parse(errorText);
                        if (errorJson.error) {
                            throw new Error(errorJson.error);
                        }
                    } catch (parseErr) {
                        // Not JSON, continue with status code handling
                    }
                } catch (e) {
                    console.error('Could not read error response:', e);
                }
                
                if (response.status === 400) {
                    throw new Error('Invalid input. Please check all fields and try again.');
                } else if (response.status === 503) {
                    throw new Error('Feedback service temporarily unavailable. Please try again later.');
                } else if (response.status === 500) {
                    throw new Error('Server error. Please try again later.');
                } else {
                    throw new Error(`HTTP Error: ${response.status}`);
                }
            }

            let result;
            try {
                result = await response.json();
                console.log('Feedback submitted successfully:', result);
            } catch (parseErr) {
                console.error('Failed to parse response:', parseErr);
                throw new Error('Invalid server response format');
            }
            
            if (!result.success && !result.message) {
                console.error('Response did not indicate success:', result);
                throw new Error('Feedback submission was not successful');
            }

            // Show success message
            this.showSuccess(this.translate('feedbackSent'));

            // Reset form after 2 seconds
            setTimeout(() => {
                this.resetForm();
                submitBtn.disabled = false;
                submitBtn.classList.remove('loading');
                submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i><span>' + this.translate('sendFeedback') + '</span>';
            }, 2000);

        } catch (error) {
            console.error('Submission error:', error.message, error.stack);
            let errorMsg = this.translate('submissionFailed');
            
            // Provide more specific error messages
            if (error.message.includes('timeout')) {
                errorMsg = 'Request timed out. Please check your connection and try again.';
            } else if (error.message.includes('Invalid input')) {
                errorMsg = 'Please check all required fields and try again.';
            } else if (error.message.includes('Server error')) {
                errorMsg = 'Server error. Please try again later.';
            } else if (error.message) {
                errorMsg = this.translate('submissionFailed') + ': ' + error.message;
            }
            
            this.showError(errorMsg);
            
            // Reset button state
            submitBtn.disabled = false;
            submitBtn.classList.remove('loading');
            submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i><span>' + this.translate('sendFeedback') + '</span>';
        }
    }

    /**
     * Reset form to initial state
     */
    resetForm() {
        document.getElementById('feedbackForm').reset();
        this.selectedType = null;
        this.attachedFiles = [];
        this.currentTotalSize = 0;

        document.querySelectorAll('.feedback-type-option').forEach(opt => {
            opt.classList.remove('active');
        });

        document.getElementById('feedbackType').value = '';
        document.getElementById('mediaPreview').innerHTML = '';
        document.getElementById('charCount').textContent = '0';

        // Re-load user info
        this.loadUserInfo();
    }

    /**
     * Show error message
     */
    showError(message) {
        console.error('Showing error:', message);
        const errorEl = document.getElementById('errorMessage');
        if (!errorEl) {
            console.error('Error element not found');
            alert(message);
            return;
        }

        errorEl.textContent = message;
        errorEl.classList.add('show');
        errorEl.style.display = 'block';
        
        // Scroll to error message
        try {
            errorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (e) {
            console.warn('Could not scroll to error message:', e);
            window.scrollTo(0, 0);
        }

        // Auto-hide after 8 seconds
        setTimeout(() => {
            if (errorEl.classList.contains('show')) {
                errorEl.classList.remove('show');
                errorEl.style.display = 'none';
            }
        }, 8000);
    }

    /**
     * Clear error message
     */
    clearError() {
        const errorEl = document.getElementById('errorMessage');
        if (errorEl) {
            errorEl.classList.remove('show');
            errorEl.style.display = 'none';
        }
    }

    /**
     * Show success message
     */
    showSuccess(message) {
        const form = document.getElementById('feedbackForm');
        if (!form) return;

        // Create success element
        const successEl = document.createElement('div');
        successEl.className = 'success-message';
        successEl.innerHTML = `
            <div style="font-size: 24px; margin-bottom: 8px;">✓</div>
            <div>${message}</div>
            <div style="font-size: 12px; color: #16a34a; margin-top: 4px;">${this.translate('redirecting')}</div>
        `;

        // Insert at top of form
        form.insertBefore(successEl, form.firstChild);

        // Scroll to success message
        successEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Redirect after 3 seconds
        setTimeout(() => {
            window.location.href = '/';
        }, 3000);
    }

    /**
     * Format file size for display
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    /**
     * Setup translations
     */
    setupTranslations() {
        if (typeof TranslationUtils !== 'undefined') {
            console.log('Applying translations for feedback page');
            TranslationUtils.applyTranslations();
        } else {
            console.warn('TranslationUtils not available');
        }
    }

    /**
     * Translate key
     */
    translate(key) {
        if (typeof TranslationUtils !== 'undefined') {
            const translation = TranslationUtils.translate(key);
            if (!translation || translation === key) {
                console.warn(`Translation key not found: ${key}`);
            }
            return translation || key;
        }
        console.warn('TranslationUtils not available for key:', key);
        return key;
    }

    /**
     * Load bottom navigation
     */
    loadBottomNav() {
        const container = document.getElementById('bottomnav-container');
        if (!container) return;

        fetch('/bottomnav.html')
            .then(r => r.ok ? r.text() : '')
            .then(html => {
                container.innerHTML = html;
                if (typeof TranslationUtils !== 'undefined') {
                    TranslationUtils.applyTranslations();
                }
            })
            .catch(e => console.log('Could not load bottom nav:', e.message));
    }
}

// Initialize feedback system when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.feedbackSystem = new FeedbackSystem();
});
