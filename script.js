// PortfolioForge - Resume to Portfolio Converter with Backend Integration
class PortfolioForge {
    constructor() {
        this.currentTheme = 'minimal';
        this.currentFile = null;
        this.portfolioId = null;
        this.extractedData = null;
        this.portfolioData = null;
        this.generatedHTML = null;
        this.apiBase = 'http://localhost:3001/api';
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupThemeToggle();
        this.setupFileUpload();
        this.setupEditor();
    }

    setupEventListeners() {
        // Theme toggle
        document.getElementById('themeToggle').addEventListener('click', () => {
            this.toggleDarkMode();
        });

        // File upload
        document.getElementById('uploadBtn').addEventListener('click', () => {
            document.getElementById('fileInput').click();
        });

        document.getElementById('fileInput').addEventListener('change', (e) => {
            this.handleFileSelect(e.target.files[0]);
        });

        // Drag and drop
        const uploadArea = document.getElementById('uploadArea');
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file) this.handleFileSelect(file);
        });

        // Generate button
        document.getElementById('generateBtn').addEventListener('click', () => {
            this.generatePortfolio();
        });

        // Export button
        document.getElementById('exportBtn').addEventListener('click', () => {
            this.exportPortfolio();
        });

        // Chatbot controls
        document.getElementById('chatbotBtn').addEventListener('click', () => {
            this.openChatbot();
        });

        document.getElementById('chatbotClose').addEventListener('click', () => {
            this.closeChatbot();
        });

        document.getElementById('sendBtn').addEventListener('click', () => {
            this.sendChatbotMessage();
        });

        document.getElementById('chatbotInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendChatbotMessage();
            }
        });

        // Quick question buttons
        document.querySelectorAll('.quick-question').forEach(btn => {
            btn.addEventListener('click', () => {
                const question = btn.dataset.question;
                document.getElementById('chatbotInput').value = question;
                this.sendChatbotMessage();
            });
        });

        // Modal controls
        document.getElementById('modalClose').addEventListener('click', () => {
            this.closeModal();
        });

        document.getElementById('modalCancel').addEventListener('click', () => {
            this.closeModal();
        });

        document.getElementById('modalSave').addEventListener('click', () => {
            this.saveModalChanges();
        });
    }

    setupThemeToggle() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        
        const themeToggle = document.getElementById('themeToggle');
        const icon = themeToggle.querySelector('i');
        icon.className = savedTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    }

    toggleDarkMode() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        
        const themeToggle = document.getElementById('themeToggle');
        const icon = themeToggle.querySelector('i');
        icon.className = newTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    }

    setupFileUpload() {
        // Additional file upload setup if needed
    }

    setupEditor() {
        // Theme options
        document.querySelectorAll('.theme-option').forEach(option => {
            option.addEventListener('click', () => {
                document.querySelectorAll('.theme-option').forEach(opt => opt.classList.remove('active'));
                option.classList.add('active');
                this.currentTheme = option.dataset.theme;
                this.updatePortfolioTheme();
            });
        });

        // Section items
        document.querySelectorAll('.section-item').forEach(item => {
            item.addEventListener('click', () => {
                const section = item.dataset.section;
                this.openEditModal(section);
            });
        });

        // Preview device controls
        document.querySelectorAll('.preview-device').forEach(device => {
            device.addEventListener('click', () => {
                document.querySelectorAll('.preview-device').forEach(dev => dev.classList.remove('active'));
                device.classList.add('active');
                
                const previewFrame = document.getElementById('previewFrame');
                previewFrame.className = 'preview-frame ' + device.dataset.device;
            });
        });
    }

    async handleFileSelect(file) {
        if (!file) return;

        const validTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
        if (!validTypes.includes(file.type) && !file.name.endsWith('.txt')) {
            alert('Please upload a PDF, DOCX, or TXT file');
            return;
        }

        this.currentFile = file;
        document.getElementById('fileName').textContent = file.name;
        document.getElementById('fileInfo').style.display = 'block';
        document.getElementById('generateBtn').style.display = 'inline-flex';
    }

    async generatePortfolio() {
        if (!this.currentFile) return;

        document.getElementById('loadingOverlay').style.display = 'flex';

        try {
            // Create FormData for file upload
            const formData = new FormData();
            formData.append('resume', this.currentFile);

            // Send to backend API
            const response = await fetch(`${this.apiBase}/upload`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error('Failed to upload and process resume');
            }

            const result = await response.json();
            
            // Store the portfolio data
            this.portfolioId = result.portfolioId;
            this.extractedData = result.extractedData;
            this.portfolioData = result.portfolioData;
            this.generatedHTML = result.generatedHTML;
            
            // Show editor
            this.showEditor();
            
            // Update preview
            this.updatePreview();
            
        } catch (error) {
            console.error('Error generating portfolio:', error);
            alert('Error generating portfolio: ' + error.message);
        } finally {
            document.getElementById('loadingOverlay').style.display = 'none';
        }
    }

    showEditor() {
        document.getElementById('uploadSection').style.display = 'none';
        document.getElementById('editorSection').style.display = 'block';
    }

    updatePreview() {
        const iframe = document.getElementById('portfolioPreview');
        if (this.generatedHTML) {
            iframe.srcdoc = this.generatedHTML;
        }
    }

    async updatePortfolioTheme() {
        if (!this.portfolioId) return;

        try {
            const response = await fetch(`${this.apiBase}/portfolio/${this.portfolioId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    theme: this.currentTheme
                })
            });

            if (!response.ok) {
                throw new Error('Failed to update theme');
            }

            const result = await response.json();
            this.generatedHTML = result.portfolio.generatedHTML;
            this.updatePreview();

        } catch (error) {
            console.error('Error updating theme:', error);
        }
    }

    openEditModal(section) {
        const modal = document.getElementById('editModal');
        const modalTitle = document.getElementById('modalTitle');
        const modalBody = document.getElementById('modalBody');
        
        modalTitle.textContent = `Edit ${section.charAt(0).toUpperCase() + section.slice(1)}`;
        
        // Generate form based on section
        modalBody.innerHTML = this.generateEditForm(section);
        
        modal.style.display = 'flex';
    }

    generateEditForm(section) {
        const data = this.extractedData;
        
        switch(section) {
            case 'hero':
                return `
                    <div class="form-group">
                        <label>Name</label>
                        <input type="text" id="edit-name" value="${data.name}">
                    </div>
                    <div class="form-group">
                        <label>Headline</label>
                        <input type="text" id="edit-headline" value="${data.headline}">
                    </div>
                    <div class="form-group">
                        <label>About</label>
                        <textarea id="edit-about">${data.about}</textarea>
                    </div>
                    <div class="form-group">
                        <label>Email</label>
                        <input type="email" id="edit-email" value="${data.email}">
                    </div>
                    <div class="form-group">
                        <label>Phone</label>
                        <input type="tel" id="edit-phone" value="${data.phone}">
                    </div>
                    <div class="form-group">
                        <label>Location</label>
                        <input type="text" id="edit-location" value="${data.location}">
                    </div>
                `;
            case 'skills':
                return `
                    <div class="form-group">
                        <label>Skills (comma-separated)</label>
                        <textarea id="edit-skills">${data.skills.join(', ')}</textarea>
                    </div>
                `;
            case 'projects':
                return `
                    <div class="form-group">
                        <label>Projects</label>
                        <div id="projects-container">
                            ${data.projects.map((project, index) => `
                                <div class="project-item" style="margin-bottom: 1rem; padding: 1rem; border: 1px solid var(--border-color); border-radius: 8px;">
                                    <input type="text" id="project-name-${index}" value="${project.name}" placeholder="Project Name" style="width: 100%; margin-bottom: 0.5rem;">
                                    <textarea id="project-desc-${index}" placeholder="Description" style="width: 100%; margin-bottom: 0.5rem;">${project.description}</textarea>
                                    <input type="text" id="project-tech-${index}" value="${project.technologies.join(', ')}" placeholder="Technologies (comma-separated)" style="width: 100%;">
                                </div>
                            `).join('')}
                        </div>
                        <button type="button" onclick="addProjectField()" style="margin-top: 1rem; padding: 0.5rem 1rem; background: var(--primary-color); color: white; border: none; border-radius: 4px; cursor: pointer;">Add Project</button>
                    </div>
                `;
            case 'experience':
                return `
                    <div class="form-group">
                        <label>Experience</label>
                        <div id="experience-container">
                            ${data.experience.map((exp, index) => `
                                <div class="experience-item" style="margin-bottom: 1rem; padding: 1rem; border: 1px solid var(--border-color); border-radius: 8px;">
                                    <input type="text" id="exp-title-${index}" value="${exp.title}" placeholder="Job Title" style="width: 100%; margin-bottom: 0.5rem;">
                                    <input type="text" id="exp-company-${index}" value="${exp.company}" placeholder="Company" style="width: 100%; margin-bottom: 0.5rem;">
                                    <input type="text" id="exp-period-${index}" value="${exp.period}" placeholder="Period" style="width: 100%; margin-bottom: 0.5rem;">
                                    <textarea id="exp-desc-${index}" placeholder="Description" style="width: 100%;">${exp.description}</textarea>
                                </div>
                            `).join('')}
                        </div>
                        <button type="button" onclick="addExperienceField()" style="margin-top: 1rem; padding: 0.5rem 1rem; background: var(--primary-color); color: white; border: none; border-radius: 4px; cursor: pointer;">Add Experience</button>
                    </div>
                `;
            case 'education':
                return `
                    <div class="form-group">
                        <label>Education</label>
                        <div id="education-container">
                            ${data.education.map((edu, index) => `
                                <div class="education-item" style="margin-bottom: 1rem; padding: 1rem; border: 1px solid var(--border-color); border-radius: 8px;">
                                    <input type="text" id="edu-degree-${index}" value="${edu.degree}" placeholder="Degree" style="width: 100%; margin-bottom: 0.5rem;">
                                    <input type="text" id="edu-school-${index}" value="${edu.school}" placeholder="School" style="width: 100%; margin-bottom: 0.5rem;">
                                    <input type="text" id="edu-period-${index}" value="${edu.period}" placeholder="Period" style="width: 100%;">
                                </div>
                            `).join('')}
                        </div>
                        <button type="button" onclick="addEducationField()" style="margin-top: 1rem; padding: 0.5rem 1rem; background: var(--primary-color); color: white; border: none; border-radius: 4px; cursor: pointer;">Add Education</button>
                    </div>
                `;
            default:
                return '<p>Editing for this section is coming soon.</p>';
        }
    }

    closeModal() {
        document.getElementById('editModal').style.display = 'none';
    }

    async saveModalChanges() {
        if (!this.portfolioId) return;

        try {
            // Collect form data
            const updatedData = this.collectFormData();
            
            // Send to backend
            const response = await fetch(`${this.apiBase}/portfolio/${this.portfolioId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    extractedData: updatedData
                })
            });

            if (!response.ok) {
                throw new Error('Failed to save changes');
            }

            const result = await response.json();
            this.extractedData = result.portfolio.extractedData;
            this.generatedHTML = result.portfolio.generatedHTML;
            
            this.updatePreview();
            this.closeModal();

        } catch (error) {
            console.error('Error saving changes:', error);
            alert('Error saving changes: ' + error.message);
        }
    }

    collectFormData() {
        const updatedData = { ...this.extractedData };

        // Collect hero section data
        const nameEl = document.getElementById('edit-name');
        const headlineEl = document.getElementById('edit-headline');
        const aboutEl = document.getElementById('edit-about');
        const emailEl = document.getElementById('edit-email');
        const phoneEl = document.getElementById('edit-phone');
        const locationEl = document.getElementById('edit-location');

        if (nameEl) updatedData.name = nameEl.value;
        if (headlineEl) updatedData.headline = headlineEl.value;
        if (aboutEl) updatedData.about = aboutEl.value;
        if (emailEl) updatedData.email = emailEl.value;
        if (phoneEl) updatedData.phone = phoneEl.value;
        if (locationEl) updatedData.location = locationEl.value;

        // Collect skills
        const skillsEl = document.getElementById('edit-skills');
        if (skillsEl) {
            updatedData.skills = skillsEl.value.split(',').map(skill => skill.trim()).filter(skill => skill);
        }

        // Collect projects
        const projectItems = document.querySelectorAll('.project-item');
        if (projectItems.length > 0) {
            updatedData.projects = Array.from(projectItems).map((item, index) => {
                const nameEl = document.getElementById(`project-name-${index}`);
                const descEl = document.getElementById(`project-desc-${index}`);
                const techEl = document.getElementById(`project-tech-${index}`);
                
                return {
                    name: nameEl ? nameEl.value : '',
                    description: descEl ? descEl.value : '',
                    technologies: techEl ? techEl.value.split(',').map(tech => tech.trim()).filter(tech => tech) : []
                };
            }).filter(project => project.name);
        }

        // Collect experience
        const expItems = document.querySelectorAll('.experience-item');
        if (expItems.length > 0) {
            updatedData.experience = Array.from(expItems).map((item, index) => {
                const titleEl = document.getElementById(`exp-title-${index}`);
                const companyEl = document.getElementById(`exp-company-${index}`);
                const periodEl = document.getElementById(`exp-period-${index}`);
                const descEl = document.getElementById(`exp-desc-${index}`);
                
                return {
                    title: titleEl ? titleEl.value : '',
                    company: companyEl ? companyEl.value : '',
                    period: periodEl ? periodEl.value : '',
                    description: descEl ? descEl.value : ''
                };
            }).filter(exp => exp.title);
        }

        // Collect education
        const eduItems = document.querySelectorAll('.education-item');
        if (eduItems.length > 0) {
            updatedData.education = Array.from(eduItems).map((item, index) => {
                const degreeEl = document.getElementById(`edu-degree-${index}`);
                const schoolEl = document.getElementById(`edu-school-${index}`);
                const periodEl = document.getElementById(`edu-period-${index}`);
                
                return {
                    degree: degreeEl ? degreeEl.value : '',
                    school: schoolEl ? schoolEl.value : '',
                    period: periodEl ? periodEl.value : ''
                };
            }).filter(edu => edu.degree);
        }

        return updatedData;
    }

    exportPortfolio() {
        if (this.generatedHTML) {
            const blob = new Blob([this.generatedHTML], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = 'portfolio.html';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } else {
            alert('No portfolio to export. Please generate a portfolio first.');
        }
    }

    // Chatbot methods
    openChatbot() {
        if (!this.portfolioId) {
            alert('Please generate a portfolio first to use the CV Assistant.');
            return;
        }
        document.getElementById('chatbotModal').style.display = 'flex';
        document.getElementById('chatbotInput').focus();
    }

    closeChatbot() {
        document.getElementById('chatbotModal').style.display = 'none';
    }

    async sendChatbotMessage() {
        const input = document.getElementById('chatbotInput');
        const message = input.value.trim();
        
        // Add user message immediately
        this.addChatMessage(message, 'user');
        
        // Clear input
        input.value = '';
        
        // Show typing indicator immediately for better UX
        this.showTypingIndicator();
        
        try {
            // Add timeout to prevent hanging requests
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
            
            const response = await fetch(`${this.apiBase}/chatbot`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    question: message,
                    portfolioId: this.portfolioId,
                    tone: document.getElementById('toneSelector').value
                }),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error('Failed to get response from chatbot');
            }
            
            const result = await response.json();
            
            // Hide typing indicator
            this.hideTypingIndicator();
            
            // Add bot response
            this.addChatMessage(result.answer, 'bot');
            
        } catch (error) {
            clearTimeout(timeoutId);
            this.hideTypingIndicator();
            
            // Show user-friendly error message
            this.addChatMessage("I'm having trouble connecting right now. Please try again in a moment.", 'bot');
            console.error('Chatbot error:', error);
        }
    }

    addChatMessage(message, sender) {
        const messagesContainer = document.getElementById('chatbotMessages');
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;
        
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        if (sender === 'bot') {
            messageDiv.innerHTML = `
                <div class="message-avatar">🤖</div>
                <div class="message-content">
                    <p>${message.replace(/\n/g, '<br>')}</p>
                    <div class="message-time">${time}</div>
                </div>
            `;
        } else {
            messageDiv.innerHTML = `
                <div class="message-content">
                    <p>${message.replace(/\n/g, '<br>')}</p>
                    <div class="message-time">${time}</div>
                </div>
                <div class="message-avatar">👤</div>
            `;
        }
        
        messagesContainer.appendChild(messageDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    showTypingIndicator() {
        const messagesContainer = document.getElementById('chatbotMessages');
        const typingDiv = document.createElement('div');
        typingDiv.className = 'message bot-message typing-indicator';
        typingDiv.id = 'typing-indicator';
        typingDiv.innerHTML = `
            <div class="message-content">
                <div class="typing-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            </div>
        `;
        
        messagesContainer.appendChild(typingDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    hideTypingIndicator() {
        const typingIndicator = document.getElementById('typing-indicator');
        if (typingIndicator) {
            typingIndicator.remove();
        }
    }
}

// Helper functions for dynamic form fields
function addProjectField() {
    const container = document.getElementById('projects-container');
    const index = container.children.length;
    
    const projectDiv = document.createElement('div');
    projectDiv.className = 'project-item';
    projectDiv.style.cssText = 'margin-bottom: 1rem; padding: 1rem; border: 1px solid var(--border-color); border-radius: 8px;';
    projectDiv.innerHTML = `
        <input type="text" id="project-name-${index}" placeholder="Project Name" style="width: 100%; margin-bottom: 0.5rem;">
        <textarea id="project-desc-${index}" placeholder="Description" style="width: 100%; margin-bottom: 0.5rem;"></textarea>
        <input type="text" id="project-tech-${index}" placeholder="Technologies (comma-separated)" style="width: 100%;">
    `;
    
    container.appendChild(projectDiv);
}

function addExperienceField() {
    const container = document.getElementById('experience-container');
    const index = container.children.length;
    
    const expDiv = document.createElement('div');
    expDiv.className = 'experience-item';
    expDiv.style.cssText = 'margin-bottom: 1rem; padding: 1rem; border: 1px solid var(--border-color); border-radius: 8px;';
    expDiv.innerHTML = `
        <input type="text" id="exp-title-${index}" placeholder="Job Title" style="width: 100%; margin-bottom: 0.5rem;">
        <input type="text" id="exp-company-${index}" placeholder="Company" style="width: 100%; margin-bottom: 0.5rem;">
        <input type="text" id="exp-period-${index}" placeholder="Period" style="width: 100%; margin-bottom: 0.5rem;">
        <textarea id="exp-desc-${index}" placeholder="Description" style="width: 100%;"></textarea>
    `;
    
    container.appendChild(expDiv);
}

function addEducationField() {
    const container = document.getElementById('education-container');
    const index = container.children.length;
    
    const eduDiv = document.createElement('div');
    eduDiv.className = 'education-item';
    eduDiv.style.cssText = 'margin-bottom: 1rem; padding: 1rem; border: 1px solid var(--border-color); border-radius: 8px;';
    eduDiv.innerHTML = `
        <input type="text" id="edu-degree-${index}" placeholder="Degree" style="width: 100%; margin-bottom: 0.5rem;">
        <input type="text" id="edu-school-${index}" placeholder="School" style="width: 100%; margin-bottom: 0.5rem;">
        <input type="text" id="edu-period-${index}" placeholder="Period" style="width: 100%;">
    `;
    
    container.appendChild(eduDiv);
}

// Quick action functions for enhanced CV Assistant
function quickAction(action) {
    const chatbotInput = document.getElementById('chatbotInput');
    const chatbotModal = document.getElementById('chatbotModal');
    
    // Show chatbot modal
    chatbotModal.style.display = 'flex';
    
    // Set predefined questions based on action
    const actionQuestions = {
        'improve-cv': 'Improve my CV and make it ATS friendly with specific suggestions for each section.',
        'generate-bio': 'Write a compelling professional portfolio bio based on my CV data.',
        'interview-questions': 'Generate technical, behavioral, and HR interview questions for my career level.',
        'ats-optimization': 'Analyze my CV for ATS compatibility and provide optimization suggestions.'
    };
    
    chatbotInput.value = actionQuestions[action] || 'How can you help me with my CV?';
    
    // Auto-send the question
    setTimeout(() => {
        if (window.portfolioForge) {
            window.portfolioForge.sendChatbotMessage();
        }
    }, 500);
}

// Direct CV upload and analysis
document.addEventListener('DOMContentLoaded', () => {
    // Add event listener for direct CV upload
    const directCvUpload = document.getElementById('directCvUpload');
    if (directCvUpload) {
        directCvUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                await analyzeDirectCV(file);
            }
        });
    }
});

async function analyzeDirectCV(file) {
    const formData = new FormData();
    formData.append('cv', file);
    
    try {
        const response = await fetch('/api/analyze-cv', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Store CV data for chatbot context
            if (window.portfolioForge) {
                window.portfolioForge.extractedData = result.cvData;
            }
            
            // Show success message and open chatbot
            alert('CV analyzed successfully! You can now ask me questions about your CV.');
            document.getElementById('chatbotModal').style.display = 'flex';
            
            // Send initial analysis message
            setTimeout(() => {
                const chatbotInput = document.getElementById('chatbotInput');
                chatbotInput.value = 'Based on my CV analysis, what are the key improvement suggestions?';
                if (window.portfolioForge) {
                    window.portfolioForge.sendChatbotMessage();
                }
            }, 1000);
        } else {
            alert('Error analyzing CV: ' + result.error);
        }
    } catch (error) {
        console.error('Error analyzing CV:', error);
        alert('Error analyzing CV. Please try again.');
    }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    new PortfolioForge();
});
