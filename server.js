const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const natural = require('natural');
const { Ollama } = require('ollama');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Ollama client
const ollama = new Ollama({ host: 'http://localhost:11434' });

// Response cache for frequently asked questions
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache helper functions
function getCacheKey(question, cvDataHash, tone) {
    return `${question.substring(0, 50)}_${cvDataHash}_${tone}`;
}

function getCvDataHash(cvData) {
    if (!cvData) return 'no-cv';
    return cvData.name + cvData.skills.slice(0, 3).join(',');
}

function getCachedResponse(key) {
    const cached = responseCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.response;
    }
    return null;
}

function setCachedResponse(key, response) {
    responseCache.set(key, {
        response,
        timestamp: Date.now()
    });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// MongoDB Connection (optional for demo)
let mongooseConnected = false;
try {
    if (process.env.MONGODB_URI && !process.env.MONGODB_URI.includes('localhost')) {
        mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        mongoose.connection.on('connected', () => {
            console.log('📊 MongoDB connected successfully');
            mongooseConnected = true;
        });
        mongoose.connection.on('error', (err) => {
            console.log('⚠️ MongoDB connection failed, using in-memory storage');
            mongooseConnected = false;
        });
    } else {
        console.log('📊 Using in-memory storage (MongoDB not configured)');
        mongooseConnected = false;
    }
} catch (error) {
    console.log('⚠️ MongoDB not available, using in-memory storage');
    mongooseConnected = false;
}

// File Upload Configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads/';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = uuidv4() + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        console.log('File received:', file.originalname, file.mimetype);
        const allowedTypes = ['.pdf', '.docx', '.txt'];
        const allowedMimeTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
        const ext = path.extname(file.originalname).toLowerCase();
        
        if (allowedTypes.includes(ext) || allowedMimeTypes.includes(file.mimetype)) {
            console.log('File accepted');
            cb(null, true);
        } else {
            console.log('File rejected - invalid type');
            cb(new Error('Invalid file type. Only PDF, DOCX, and TXT files are allowed.'));
        }
    }
});

// In-memory storage fallback
const inMemoryStorage = {
    users: new Map(),
    portfolios: new Map(),
    chatbotTraining: new Map() // Store trained chatbot data per portfolio
};

// MongoDB Schemas (only used if MongoDB is available)
const UserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    email: String,
    name: String,
    createdAt: { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now }
});

const PortfolioSchema = new mongoose.Schema({
    portfolioId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    originalFileName: String,
    extractedData: {
        name: String,
        headline: String,
        email: String,
        phone: String,
        location: String,
        about: String,
        skills: [String],
        experience: [{
            title: String,
            company: String,
            period: String,
            description: String
        }],
        education: [{
            degree: String,
            school: String,
            period: String
        }],
        projects: [{
            name: String,
            description: String,
            technologies: [String]
        }]
    },
    portfolioData: {
        tagline: String,
        seo: {
            title: String,
            description: String,
            keywords: String
        }
    },
    theme: { type: String, default: 'minimal' },
    customizations: {
        colors: Object,
        layout: String
    },
    generatedHTML: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Conditional model creation
let User, Portfolio;
if (mongooseConnected) {
    User = mongoose.model('User', UserSchema);
    Portfolio = mongoose.model('Portfolio', PortfolioSchema);
}

// Resume Parser Class
class ResumeParser {
    constructor() {
        this.tokenizer = new natural.WordTokenizer();
        this.stemmer = natural.PorterStemmer;
        
        // Common skill keywords
        this.skillKeywords = [
            'javascript', 'python', 'java', 'react', 'angular', 'vue', 'nodejs',
            'express', 'django', 'flask', 'sql', 'mongodb', 'html', 'css',
            'typescript', 'git', 'docker', 'aws', 'azure', 'gcp', 'kubernetes',
            'jquery', 'bootstrap', 'tailwind', 'webpack', 'babel', 'rest',
            'graphql', 'api', 'microservices', 'agile', 'scrum', 'devops',
            'ci/cd', 'testing', 'unit', 'integration', 'automation'
        ];
        
        // Experience indicators
        this.experienceIndicators = [
            'years', 'year', 'experience', 'worked', 'developed', 'managed',
            'led', 'created', 'built', 'implemented', 'designed', 'architected'
        ];
    }

    async parseResume(text, fileName) {
        const lines = text.split('\n').filter(line => line.trim());
        const cleanText = text.toLowerCase();
        
        return {
            name: this.extractName(lines),
            headline: this.extractHeadline(lines, cleanText),
            email: this.extractEmail(text),
            phone: this.extractPhone(text),
            location: this.extractLocation(lines, cleanText),
            about: this.extractAbout(lines, cleanText),
            skills: this.extractSkills(cleanText),
            experience: this.extractExperience(lines, cleanText),
            education: this.extractEducation(lines, cleanText),
            projects: this.extractProjects(lines, cleanText)
        };
    }

    extractName(lines) {
        // Look for name in first few lines
        for (let i = 0; i < Math.min(5, lines.length); i++) {
            const line = lines[i].trim();
            // Skip lines with emails, phones, or common header words
            if (!line.includes('@') && !line.includes('(') && 
                !line.toLowerCase().includes('resume') && 
                !line.toLowerCase().includes('curriculum') &&
                line.length > 2 && line.length < 50 &&
                /^[A-Za-z\s]+$/.test(line)) {
                return line;
            }
        }
        return 'John Doe';
    }

    extractHeadline(lines, cleanText) {
        // Look for professional titles
        const titleKeywords = ['developer', 'engineer', 'manager', 'designer', 'analyst', 'consultant', 'architect'];
        
        for (let i = 0; i < Math.min(10, lines.length); i++) {
            const line = lines[i].toLowerCase();
            for (const keyword of titleKeywords) {
                if (line.includes(keyword)) {
                    return lines[i].trim();
                }
            }
        }
        return 'Software Developer';
    }

    extractEmail(text) {
        const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
        const matches = text.match(emailRegex);
        return matches ? matches[0] : 'john@example.com';
    }

    extractPhone(text) {
        const phoneRegex = /(\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g;
        const matches = text.match(phoneRegex);
        return matches ? matches[0] : '+1 (555) 123-4567';
    }

    extractLocation(lines, cleanText) {
        // Look for location patterns
        const locationPatterns = [
            /\b[A-Za-z\s]+,\s*[A-Z]{2}\b/g,  // City, State
            /\b[A-Za-z\s]+,\s*[A-Za-z]+\b/g   // City, Country
        ];
        
        for (const pattern of locationPatterns) {
            const matches = cleanText.match(pattern);
            if (matches && matches.length > 0) {
                return matches[0].trim();
            }
        }
        return 'San Francisco, CA';
    }

    extractAbout(lines, cleanText) {
        // Look for summary/objective sections
        const summaryKeywords = ['summary', 'objective', 'about', 'profile', 'overview'];
        
        for (let i = 0; i < lines.length - 1; i++) {
            const currentLine = lines[i].toLowerCase();
            if (summaryKeywords.some(keyword => currentLine.includes(keyword))) {
                // Return the next few lines as the summary
                const summaryLines = [];
                for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                    if (lines[j].trim().length > 10) {
                        summaryLines.push(lines[j].trim());
                    }
                }
                return summaryLines.join(' ') || 'Passionate professional with expertise in modern technologies and a commitment to excellence.';
            }
        }
        return 'Passionate professional with expertise in modern technologies and a commitment to excellence.';
    }

    extractSkills(cleanText) {
        const foundSkills = [];
        const tokens = this.tokenizer.tokenize(cleanText);
        
        for (const skill of this.skillKeywords) {
            if (cleanText.includes(skill)) {
                foundSkills.push(skill.charAt(0).toUpperCase() + skill.slice(1));
            }
        }
        
        // Add common variations
        if (cleanText.includes('js') || cleanText.includes('javascript')) {
            if (!foundSkills.includes('JavaScript')) foundSkills.push('JavaScript');
        }
        if (cleanText.includes('react') || cleanText.includes('reactjs')) {
            if (!foundSkills.includes('React')) foundSkills.push('React');
        }
        
        return foundSkills.length > 0 ? foundSkills : ['JavaScript', 'React', 'Node.js', 'Python', 'SQL'];
    }

    extractExperience(lines, cleanText) {
        const experiences = [];
        let currentExperience = null;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const lowerLine = line.toLowerCase();
            
            // Look for experience indicators
            if (this.experienceIndicators.some(indicator => lowerLine.includes(indicator)) ||
                /\d{4}|\d{2}\/\d{2}|\d{1,2}\/\d{4}/.test(line)) {
                
                if (currentExperience && currentExperience.title) {
                    experiences.push(currentExperience);
                }
                
                currentExperience = {
                    title: this.extractTitle(line),
                    company: this.extractCompany(line),
                    period: this.extractPeriod(line),
                    description: ''
                };
            } else if (currentExperience && line.length > 20) {
                currentExperience.description += line + ' ';
            }
        }
        
        if (currentExperience && currentExperience.title) {
            experiences.push(currentExperience);
        }
        
        return experiences.length > 0 ? experiences : [{
            title: 'Senior Software Developer',
            company: 'Tech Company',
            period: '2020 - Present',
            description: 'Led development of enterprise applications using modern technologies and best practices.'
        }];
    }

    extractTitle(line) {
        const titleKeywords = ['senior', 'junior', 'lead', 'principal', 'software', 'developer', 'engineer', 'manager'];
        const words = line.split(' ');
        
        for (const keyword of titleKeywords) {
            if (line.toLowerCase().includes(keyword)) {
                return line;
            }
        }
        return 'Software Developer';
    }

    extractCompany(line) {
        // Simple company extraction - look for capitalized words after title
        const words = line.split(' ');
        const capitalizedWords = words.filter(word => 
            word.length > 2 && word[0] === word[0].toUpperCase()
        );
        return capitalizedWords.length > 0 ? capitalizedWords[0] : 'Tech Company';
    }

    extractPeriod(line) {
        const dateRegex = /\d{4}|\d{2}\/\d{2}|\d{1,2}\/\d{4}|present|current/gi;
        const matches = line.match(dateRegex);
        return matches ? matches.join(' - ') : '2020 - Present';
    }

    extractEducation(lines, cleanText) {
        const education = [];
        const educationKeywords = ['university', 'college', 'bachelor', 'master', 'phd', 'degree', 'diploma'];
        
        for (const line of lines) {
            const lowerLine = line.toLowerCase();
            if (educationKeywords.some(keyword => lowerLine.includes(keyword))) {
                education.push({
                    degree: line.trim(),
                    school: this.extractSchool(line),
                    period: this.extractEducationPeriod(line)
                });
            }
        }
        
        return education.length > 0 ? education : [{
            degree: 'Bachelor of Science in Computer Science',
            school: 'University Name',
            period: '2016 - 2020'
        }];
    }

    extractSchool(line) {
        const words = line.split(' ');
        const capitalizedWords = words.filter(word => 
            word.length > 3 && word[0] === word[0].toUpperCase() && 
            !word.toLowerCase().includes('bachelor') && 
            !word.toLowerCase().includes('master')
        );
        return capitalizedWords.length > 0 ? capitalizedWords.join(' ') : 'University Name';
    }

    extractEducationPeriod(line) {
        const yearRegex = /\d{4}/g;
        const matches = line.match(yearRegex);
        return matches && matches.length >= 2 ? `${matches[0]} - ${matches[1]}` : '2016 - 2020';
    }

    extractProjects(lines, cleanText) {
        const projects = [];
        const projectKeywords = ['project', 'application', 'system', 'platform', 'website', 'app'];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const lowerLine = line.toLowerCase();
            
            if (projectKeywords.some(keyword => lowerLine.includes(keyword)) && line.length > 10) {
                const technologies = this.extractTechnologies(cleanText);
                projects.push({
                    name: line,
                    description: this.extractProjectDescription(lines, i),
                    technologies: technologies
                });
            }
        }
        
        return projects.length > 0 ? projects : [{
            name: 'E-commerce Platform',
            description: 'Full-stack web application with user authentication, payment processing, and inventory management.',
            technologies: ['React', 'Node.js', 'MongoDB']
        }];
    }

    extractProjectDescription(lines, startIndex) {
        const description = [];
        for (let i = startIndex + 1; i < Math.min(startIndex + 3, lines.length); i++) {
            if (lines[i].trim().length > 10) {
                description.push(lines[i].trim());
            }
        }
        return description.join(' ') || 'A comprehensive web application showcasing modern development practices.';
    }

    extractTechnologies(cleanText) {
        const techKeywords = ['react', 'angular', 'vue', 'node', 'python', 'java', 'javascript', 'mongodb', 'sql'];
        const found = [];
        
        for (const tech of techKeywords) {
            if (cleanText.includes(tech)) {
                found.push(tech.charAt(0).toUpperCase() + tech.slice(1));
            }
        }
        
        return found.length > 0 ? found.slice(0, 3) : ['React', 'Node.js', 'MongoDB'];
    }
}

// Portfolio Generator
class PortfolioGenerator {
    generatePortfolioData(extractedData) {
        const skills = extractedData.skills.slice(0, 6);
        const tagline = `${extractedData.headline} | ${skills.slice(0, 3).join(' • ')}`;
        
        return {
            tagline,
            seo: {
                title: `${extractedData.name} - ${extractedData.headline}`,
                description: extractedData.about,
                keywords: extractedData.skills.join(', ')
            }
        };
    }

    generatePortfolioHTML(extractedData, portfolioData, theme = 'minimal') {
        const themeColors = this.getThemeColors(theme);
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${portfolioData.seo.title}</title>
    <meta name="description" content="${portfolioData.seo.description}">
    <meta name="keywords" content="${portfolioData.seo.keywords}">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        :root {
            --primary: ${themeColors.primary};
            --secondary: ${themeColors.secondary};
            --text: #1e293b;
            --text-light: #64748b;
            --bg: #ffffff;
            --bg-light: #f8fafc;
        }
        
        body {
            font-family: 'Inter', sans-serif;
            line-height: 1.6;
            color: var(--text);
            background: var(--bg);
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 2rem;
        }
        
        .hero {
            min-height: 100vh;
            display: flex;
            align-items: center;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            position: relative;
            overflow: hidden;
        }
        
        .hero::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.1);
            backdrop-filter: blur(100px);
        }
        
        .hero-content {
            position: relative;
            z-index: 1;
            text-align: center;
        }
        
        .hero h1 {
            font-size: clamp(2.5rem, 8vw, 4rem);
            font-weight: 800;
            margin-bottom: 1rem;
            animation: fadeInUp 1s ease-out;
        }
        
        .hero .tagline {
            font-size: clamp(1.2rem, 3vw, 1.5rem);
            margin-bottom: 2rem;
            opacity: 0.9;
            animation: fadeInUp 1s ease-out 0.2s both;
        }
        
        .hero .about {
            font-size: 1.1rem;
            max-width: 600px;
            margin: 0 auto 3rem;
            opacity: 0.8;
            animation: fadeInUp 1s ease-out 0.4s both;
        }
        
        .contact-info {
            display: flex;
            gap: 2rem;
            justify-content: center;
            flex-wrap: wrap;
            animation: fadeInUp 1s ease-out 0.6s both;
        }
        
        .contact-item {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 1rem;
        }
        
        .section {
            padding: 5rem 0;
        }
        
        .section:nth-child(even) {
            background: var(--bg-light);
        }
        
        .section-header {
            text-align: center;
            margin-bottom: 3rem;
        }
        
        .section h2 {
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 1rem;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .skills-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 1rem;
        }
        
        .skill-tag {
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            padding: 0.75rem 1.5rem;
            border-radius: 25px;
            text-align: center;
            font-weight: 500;
            transition: transform 0.3s ease;
        }
        
        .skill-tag:hover {
            transform: translateY(-3px);
        }
        
        .projects-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 2rem;
        }
        
        .project-card {
            background: white;
            border-radius: 15px;
            padding: 2rem;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            transition: transform 0.3s ease;
        }
        
        .project-card:hover {
            transform: translateY(-5px);
        }
        
        .project-card h3 {
            color: var(--primary);
            margin-bottom: 1rem;
        }
        
        .project-tech {
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
            margin-top: 1rem;
        }
        
        .tech-tag {
            background: var(--bg-light);
            color: var(--text-light);
            padding: 0.25rem 0.75rem;
            border-radius: 15px;
            font-size: 0.875rem;
        }
        
        .timeline {
            position: relative;
            max-width: 800px;
            margin: 0 auto;
        }
        
        .timeline::before {
            content: '';
            position: absolute;
            left: 50%;
            top: 0;
            bottom: 0;
            width: 2px;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            transform: translateX(-50%);
        }
        
        .timeline-item {
            position: relative;
            margin-bottom: 3rem;
        }
        
        .timeline-content {
            background: white;
            padding: 2rem;
            border-radius: 15px;
            box-shadow: 0 5px 20px rgba(0,0,0,0.1);
            width: calc(50% - 2rem);
        }
        
        .timeline-item:nth-child(odd) .timeline-content {
            margin-left: auto;
        }
        
        .timeline-dot {
            position: absolute;
            left: 50%;
            top: 2rem;
            width: 20px;
            height: 20px;
            background: var(--primary);
            border-radius: 50%;
            transform: translateX(-50%);
        }
        
        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        @media (max-width: 768px) {
            .timeline::before {
                left: 2rem;
            }
            
            .timeline-content {
                width: calc(100% - 4rem);
                margin-left: 4rem !important;
            }
            
            .timeline-dot {
                left: 2rem;
            }
            
            .contact-info {
                flex-direction: column;
                gap: 1rem;
            }
        }
    </style>
</head>
<body>
    <section class="hero">
        <div class="container">
            <div class="hero-content">
                <h1>${extractedData.name}</h1>
                <p class="tagline">${portfolioData.tagline}</p>
                <p class="about">${extractedData.about}</p>
                <div class="contact-info">
                    <div class="contact-item">
                        <i class="fas fa-envelope"></i>
                        <span>${extractedData.email}</span>
                    </div>
                    <div class="contact-item">
                        <i class="fas fa-phone"></i>
                        <span>${extractedData.phone}</span>
                    </div>
                    <div class="contact-item">
                        <i class="fas fa-map-marker-alt"></i>
                        <span>${extractedData.location}</span>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <section class="section">
        <div class="container">
            <div class="section-header">
                <h2>Skills</h2>
            </div>
            <div class="skills-grid">
                ${extractedData.skills.map(skill => `<div class="skill-tag">${skill}</div>`).join('')}
            </div>
        </div>
    </section>

    <section class="section">
        <div class="container">
            <div class="section-header">
                <h2>Projects</h2>
            </div>
            <div class="projects-grid">
                ${extractedData.projects.map(project => `
                    <div class="project-card">
                        <h3>${project.name}</h3>
                        <p>${project.description}</p>
                        <div class="project-tech">
                            ${project.technologies.map(tech => `<span class="tech-tag">${tech}</span>`).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    </section>

    <section class="section">
        <div class="container">
            <div class="section-header">
                <h2>Experience</h2>
            </div>
            <div class="timeline">
                ${extractedData.experience.map(exp => `
                    <div class="timeline-item">
                        <div class="timeline-dot"></div>
                        <div class="timeline-content">
                            <h3>${exp.title}</h3>
                            <h4>${exp.company}</h4>
                            <p style="color: var(--text-light); margin-bottom: 1rem;">${exp.period}</p>
                            <p>${exp.description}</p>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    </section>

    <section class="section">
        <div class="container">
            <div class="section-header">
                <h2>Education</h2>
            </div>
            <div class="timeline">
                ${extractedData.education.map(edu => `
                    <div class="timeline-item">
                        <div class="timeline-dot"></div>
                        <div class="timeline-content">
                            <h3>${edu.degree}</h3>
                            <h4>${edu.school}</h4>
                            <p style="color: var(--text-light);">${edu.period}</p>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    </section>
</body>
</html>`;
    }

    getThemeColors(theme) {
        const themes = {
            minimal: { primary: '#667eea', secondary: '#764ba2' },
            futuristic: { primary: '#00d4ff', secondary: '#090979' },
            creative: { primary: '#f093fb', secondary: '#f5576c' },
            corporate: { primary: '#1e3a8a', secondary: '#3b82f6' }
        };
        return themes[theme] || themes.minimal;
    }
}

// Initialize parsers and generators
const resumeParser = new ResumeParser();
const portfolioGenerator = new PortfolioGenerator();

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'PortfolioForge API is running' });
});

// Upload and process resume
app.post('/api/upload', upload.single('resume'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const filePath = req.file.path;
        let text = '';

        // Extract text based on file type
        if (req.file.mimetype === 'application/pdf') {
            const dataBuffer = fs.readFileSync(filePath);
            const pdfData = await pdfParse(dataBuffer);
            text = pdfData.text;
        } else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ path: filePath });
            text = result.value;
        } else {
            text = fs.readFileSync(filePath, 'utf8');
        }

        // Parse resume
        const extractedData = await resumeParser.parseResume(text, req.file.originalname);
        
        // Generate portfolio data
        const portfolioData = portfolioGenerator.generatePortfolioData(extractedData);
        
        // Generate HTML
        const generatedHTML = portfolioGenerator.generatePortfolioHTML(extractedData, portfolioData);

        // Create user and portfolio data
        const userId = uuidv4();
        const portfolioId = uuidv4();
        const userData = {
            userId,
            email: extractedData.email,
            name: extractedData.name,
            createdAt: new Date(),
            lastActive: new Date()
        };
        
        const portfolioDataToSave = {
            portfolioId,
            userId,
            originalFileName: req.file.originalname,
            extractedData,
            portfolioData,
            generatedHTML,
            theme: 'minimal',
            createdAt: new Date(),
            updatedAt: new Date()
        };

        // Save to appropriate storage
        if (mongooseConnected && User && Portfolio) {
            // Use MongoDB
            const user = new User(userData);
            await user.save();

            const portfolio = new Portfolio(portfolioDataToSave);
            await portfolio.save();
        } else {
            // Use in-memory storage
            inMemoryStorage.users.set(userId, userData);
            inMemoryStorage.portfolios.set(portfolioId, portfolioDataToSave);
        }

        // Clean up uploaded file
        fs.unlinkSync(filePath);

        res.json({
            success: true,
            portfolioId,
            extractedData,
            portfolioData,
            generatedHTML
        });

    } catch (error) {
        console.error('Error processing resume:', error);
        res.status(500).json({ error: 'Error processing resume: ' + error.message });
    }
});

// Get portfolio by ID
app.get('/api/portfolio/:id', async (req, res) => {
    try {
        let portfolio;
        
        if (mongooseConnected && Portfolio) {
            portfolio = await Portfolio.findOne({ portfolioId: req.params.id });
        } else {
            portfolio = inMemoryStorage.portfolios.get(req.params.id);
        }
        
        if (!portfolio) {
            return res.status(404).json({ error: 'Portfolio not found' });
        }
        res.json(portfolio);
    } catch (error) {
        console.error('Error fetching portfolio:', error);
        res.status(500).json({ error: 'Error fetching portfolio' });
    }
});

// Update portfolio
app.put('/api/portfolio/:id', async (req, res) => {
    try {
        let portfolio;
        
        if (mongooseConnected && Portfolio) {
            portfolio = await Portfolio.findOne({ portfolioId: req.params.id });
        } else {
            portfolio = inMemoryStorage.portfolios.get(req.params.id);
        }
        
        if (!portfolio) {
            return res.status(404).json({ error: 'Portfolio not found' });
        }

        // Update portfolio data
        const { extractedData, theme, customizations } = req.body;
        
        if (extractedData) {
            portfolio.extractedData = { ...portfolio.extractedData, ...extractedData };
            portfolio.portfolioData = portfolioGenerator.generatePortfolioData(portfolio.extractedData);
        }
        
        if (theme) portfolio.theme = theme;
        if (customizations) portfolio.customizations = customizations;

        // Regenerate HTML
        portfolio.generatedHTML = portfolioGenerator.generatePortfolioHTML(
            portfolio.extractedData,
            portfolio.portfolioData,
            portfolio.theme
        );

        portfolio.updatedAt = new Date();

        // Save to appropriate storage
        if (mongooseConnected && Portfolio) {
            await portfolio.save();
        } else {
            inMemoryStorage.portfolios.set(req.params.id, portfolio);
        }

        res.json({ success: true, portfolio });
    } catch (error) {
        console.error('Error updating portfolio:', error);
        res.status(500).json({ error: 'Error updating portfolio' });
    }
});

// Get user portfolios
app.get('/api/user/:userId/portfolios', async (req, res) => {
    try {
        let portfolios;
        
        if (mongooseConnected && Portfolio) {
            portfolios = await Portfolio.find({ userId: req.params.userId })
                .sort({ updatedAt: -1 });
        } else {
            // Filter in-memory portfolios by userId
            portfolios = Array.from(inMemoryStorage.portfolios.values())
                .filter(p => p.userId === req.params.userId)
                .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        }
        
        res.json(portfolios);
    } catch (error) {
        console.error('Error fetching user portfolios:', error);
        res.status(500).json({ error: 'Error fetching portfolios' });
    }
});

// Delete portfolio
app.delete('/api/portfolio/:id', async (req, res) => {
    try {
        if (mongooseConnected && Portfolio) {
            const result = await Portfolio.deleteOne({ portfolioId: req.params.id });
            if (result.deletedCount === 0) {
                return res.status(404).json({ error: 'Portfolio not found' });
            }
        } else {
            const deleted = inMemoryStorage.portfolios.delete(req.params.id);
            if (!deleted) {
                return res.status(404).json({ error: 'Portfolio not found' });
            }
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting portfolio:', error);
        res.status(500).json({ error: 'Error deleting portfolio' });
    }
});

// Serve generated portfolios
app.get('/portfolio/:id', async (req, res) => {
    try {
        let portfolio;
        
        if (mongooseConnected && Portfolio) {
            portfolio = await Portfolio.findOne({ portfolioId: req.params.id });
        } else {
            portfolio = inMemoryStorage.portfolios.get(req.params.id);
        }
        
        if (!portfolio) {
            return res.status(404).send('Portfolio not found');
        }
        res.send(portfolio.generatedHTML);
    } catch (error) {
        console.error('Error serving portfolio:', error);
        res.status(500).send('Error serving portfolio');
    }
});

// Enhanced Chatbot endpoint with comprehensive Ollama AI integration - Optimized for speed
app.post('/api/chatbot', async (req, res) => {
    try {
        const { question, portfolioId, tone = 'professional', cvContent } = req.body;
        
        let portfolio;
        let cvData = null;
        
        // Get portfolio data if portfolioId is provided
        if (portfolioId) {
            if (mongooseConnected && Portfolio) {
                portfolio = await Portfolio.findOne({ portfolioId: portfolioId });
            } else {
                portfolio = inMemoryStorage.portfolios.get(portfolioId);
            }
            
            if (portfolio) {
                cvData = portfolio.extractedData;
            }
        }
        
        // Use provided CV content if available (for direct CV paste/upload)
        if (cvContent) {
            cvData = await parseCVContent(cvContent);
        }
        
        // Try to get enhanced response from Ollama first with optimized settings
        let answer;
        try {
            answer = await getOptimizedAIResponse(question, cvData, tone);
        } catch (ollamaError) {
            console.log('Ollama not available, falling back to rule-based responses:', ollamaError.message);
            // Fallback to existing rule-based chatbot
            if (cvData) {
                answer = await cvChatbot.answerQuestion(question, cvData, tone);
            } else {
                answer = "Please upload your CV first so I can provide personalized assistance.";
            }
        }
        
        res.json({ answer });
    } catch (error) {
        console.error('Error in chatbot:', error);
        res.status(500).json({ error: 'Error processing question' });
    }
});

// CV Content Parser for direct uploads/pasted content
async function parseCVContent(cvContent) {
    const resumeParser = new ResumeParser();
    return await resumeParser.parseResume(cvContent, 'pasted-content');
}

// Optimized AI Response Function for faster responses with caching
async function getOptimizedAIResponse(question, cvData, tone) {
    // Check cache first
    const cvDataHash = getCvDataHash(cvData);
    const cacheKey = getCacheKey(question, cvDataHash, tone);
    const cachedResponse = getCachedResponse(cacheKey);
    
    if (cachedResponse) {
        console.log('Cache hit for:', question.substring(0, 30));
        return cachedResponse;
    }
    
    // Create a more concise prompt for faster processing
    const concisePrompt = `You are Kyro AI, a career coach. Help with CV, portfolio, interview prep, and career advice.

CV Data: ${cvData ? `
Name: ${cvData.name}
Skills: ${cvData.skills.slice(0, 5).join(', ')} 
Experience: ${cvData.experience.slice(0, 2).map(exp => `${exp.title} at ${exp.company}`).join('; ')}
` : 'No CV data'}

Question: ${question}
Tone: ${tone}

Provide a concise, structured response with bullet points. Be helpful and professional. Focus on actionable advice.`;

    try {
        const response = await ollama.chat({
            model: 'llama3', 
            messages: [
                {
                    role: 'system',
                    content: 'You are Kyro AI, a professional career coach. Provide concise, actionable advice for CV improvement, interview preparation, and career guidance. Use bullet points and be direct.'
                },
                {
                    role: 'user',
                    content: concisePrompt
                }
            ],
            options: {
                temperature: 0.3, // Lower temperature for faster, more consistent responses
                top_p: 0.9,
                max_tokens: 300, // Limit tokens for faster response
                num_predict: 250,
                stream: false // Disable streaming for faster response
            }
        });

        const answer = response.message.content;
        
        // Cache the response
        setCachedResponse(cacheKey, answer);
        
        return answer;
    } catch (error) {
        console.error('Ollama API error:', error);
        throw error;
    }
}

// Comprehensive AI Response Function with all requested features (kept for detailed analysis)
async function getComprehensiveAIResponse(question, cvData, tone) {
    const systemPrompt = `You are Kyro AI, a professional career coach and CV optimization expert. You specialize in:

1. CV ANALYSIS & IMPROVEMENT:
- Analyze entire CV for strengths and weaknesses
- Suggest improvements to structure, wording, and formatting
- Recommend better phrasing for experience and skills
- Identify missing sections (projects, achievements, certifications)
- Provide ATS optimization recommendations

2. PORTFOLIO OPTIMIZATION:
- Generate professional portfolio bios and summaries
- Improve project descriptions with impact and results
- Suggest GitHub portfolio ideas and structure
- Create compelling personal introductions

3. CAREER GUIDANCE & JOB PREPARATION:
- Interview preparation (technical, HR, behavioral questions)
- Resume optimization for specific roles
- LinkedIn profile enhancement suggestions
- Career path recommendations based on skills
- Salary expectations and negotiation tips

4. ATS OPTIMIZATION:
- Keyword recommendations for specific job roles
- Formatting tips for ATS compatibility
- Skill suggestions based on job descriptions
- ATS scoring improvement strategies

RESPONSE GUIDELINES:
- Be professional, supportive, and actionable
- Use structured format with clear headings and bullet points
- Provide specific examples and measurable improvements
- Never generate fake experience or false credentials
- Focus on honest, realistic improvements
- Always base advice on the user's actual CV data when available
- Respond in the same language as the user's question

SAFETY RULES:
- DO NOT create fake work experience, degrees, or certifications
- DO NOT encourage lying or exaggeration on CVs
- DO focus on highlighting real achievements and skills
- DO provide honest improvement suggestions

CV Data Context:
${cvData ? `
Name: ${cvData.name}
Headline: ${cvData.headline}
About: ${cvData.about}
Skills: ${cvData.skills.join(', ')}
Experience: ${cvData.experience.map(exp => `${exp.title} at ${exp.company}: ${exp.description}`).join('; ')}
Education: ${cvData.education.map(edu => `${edu.degree} from ${edu.school}`).join('; ')}
Projects: ${cvData.projects.map(proj => `${proj.name}: ${proj.description}`).join('; ')}
` : 'No CV data available. Please ask user to upload their CV first.'}

User Question: ${question}

Provide a comprehensive, structured response following the guidelines above.`;

    try {
        const response = await ollama.chat({
            model: 'llama3', // Updated to use llama3 for better performance
            messages: [
                {
                    role: 'system',
                    content: systemPrompt
                },
                {
                    role: 'user',
                    content: question
                }
            ]
        });

        return response.message.content;
    } catch (error) {
        console.error('Ollama API error:', error);
        throw error;
    }
}

// Additional endpoint for direct CV analysis
app.post('/api/analyze-cv', upload.single('cv'), async (req, res) => {
    try {
        if (!req.file && !req.body.cvText) {
            return res.status(400).json({ error: 'No CV file or text provided' });
        }

        let cvText;
        if (req.file) {
            // Process uploaded file
            const filePath = req.file.path;
            if (req.file.mimetype === 'application/pdf') {
                const dataBuffer = fs.readFileSync(filePath);
                const pdfData = await pdfParse(dataBuffer);
                cvText = pdfData.text;
            } else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                const result = await mammoth.extractRawText({ path: filePath });
                cvText = result.value;
            } else {
                cvText = fs.readFileSync(filePath, 'utf8');
            }
            // Clean up uploaded file
            fs.unlinkSync(filePath);
        } else {
            cvText = req.body.cvText;
        }

        // Parse and analyze CV
        const resumeParser = new ResumeParser();
        const cvData = await resumeParser.parseResume(cvText, req.file?.originalname || 'pasted-content');
        
        // Generate comprehensive analysis
        const analysis = await getComprehensiveAIResponse(
            "Please analyze this CV and provide detailed improvement suggestions, ATS optimization tips, and portfolio recommendations.", 
            cvData, 
            'professional'
        );

        res.json({
            success: true,
            cvData,
            analysis,
            suggestions: analysis
        });
    } catch (error) {
        console.error('Error analyzing CV:', error);
        res.status(500).json({ error: 'Error analyzing CV' });
    }
});

// CV Chatbot Class
class CVChatbot {
    constructor() {
        this.responses = {
            friendly: {
                greeting: "Hey there! I'm your personal CV assistant, fully trained on your resume data! 😊",
                skills: "Based on your uploaded CV, here are your awesome skills:",
                experience: "Let me tell you about your work experience from your resume:",
                projects: "Here are the amazing projects I found in your CV:",
                education: "Your educational background from your CV:",
                contact: "Here's your contact information from your resume:",
                improvement: "Based on your CV analysis, here are personalized suggestions:",
                default: "That's a great question! Let me analyze your CV data to give you the best answer."
            },
            professional: {
                greeting: "Good day. I am your CV assistant, fully trained on your uploaded resume data.",
                skills: "Based on your resume analysis, your professional competencies include:",
                experience: "Your professional experience as documented in your curriculum vitae:",
                projects: "Your project portfolio as detailed in your resume:",
                education: "Your educational qualifications from your curriculum vitae:",
                contact: "Your professional contact information:",
                improvement: "Based on comprehensive CV analysis, here are strategic recommendations:",
                default: "Thank you for your inquiry. I will analyze your resume data to provide accurate information."
            },
            formal: {
                greeting: "Greetings. I am your automated CV assistant, comprehensively trained on your uploaded curriculum vitae data.",
                skills: "Upon detailed review of your curriculum vitae, the following professional competencies have been identified:",
                experience: "Your professional experience as comprehensively documented in your curriculum vitae:",
                projects: "Your project portfolio as thoroughly detailed in your curriculum vitae:",
                education: "Your academic credentials as documented in your curriculum vitae:",
                contact: "Your professional contact information as specified in your curriculum vitae:",
                improvement: "Following comprehensive analysis of your curriculum vitae, permit me to offer these strategic recommendations:",
                default: "I appreciate your inquiry. I will analyze your comprehensive CV data to provide detailed, accurate information."
            }
        };
        
        this.trainingData = null;
        this.isFullyTrained = false;
    }
    
    // Comprehensive training with CV data
    trainWithCVData(cvData, portfolioId) {
        console.log(`🧠 Training chatbot with CV data for portfolio: ${portfolioId}`);
        
        this.trainingData = {
            portfolioId,
            name: cvData.name,
            headline: cvData.headline,
            email: cvData.email,
            phone: cvData.phone,
            location: cvData.location,
            about: cvData.about,
            skills: cvData.skills || [],
            experience: cvData.experience || [],
            education: cvData.education || [],
            projects: cvData.projects || [],
            
            // Enhanced knowledge base
            knowledgeBase: this.createComprehensiveKnowledgeBase(cvData),
            
            // Training metadata
            trainedAt: new Date(),
            dataCompleteness: this.assessDataCompleteness(cvData)
        };
        
        // Store training data in memory for persistence
        inMemoryStorage.chatbotTraining.set(portfolioId, this.trainingData);
        
        this.isFullyTrained = true;
        console.log(`✅ Chatbot fully trained on ${cvData.name}'s CV data`);
        
        return this.trainingData;
    }
    
    // Load pre-trained data if available
    loadTrainingData(portfolioId) {
        if (inMemoryStorage.chatbotTraining.has(portfolioId)) {
            this.trainingData = inMemoryStorage.chatbotTraining.get(portfolioId);
            this.isFullyTrained = true;
            console.log(`📚 Loaded pre-trained chatbot data for portfolio: ${portfolioId}`);
            return true;
        }
        return false;
    }
    
    // Assess completeness of CV data
    assessDataCompleteness(cvData) {
        let score = 0;
        let maxScore = 0;
        
        // Check each section
        const sections = [
            { name: 'name', data: cvData.name, weight: 10 },
            { name: 'headline', data: cvData.headline, weight: 10 },
            { name: 'email', data: cvData.email, weight: 10 },
            { name: 'phone', data: cvData.phone, weight: 10 },
            { name: 'location', data: cvData.location, weight: 5 },
            { name: 'about', data: cvData.about, weight: 15 },
            { name: 'skills', data: cvData.skills, weight: 20 },
            { name: 'experience', data: cvData.experience, weight: 20 },
            { name: 'education', data: cvData.education, weight: 10 }
        ];
        
        sections.forEach(section => {
            maxScore += section.weight;
            if (section.data && 
                (typeof section.data === 'string' ? section.data.length > 0 : section.data.length > 0)) {
                score += section.weight;
            }
        });
        
        return {
            score: Math.round((score / maxScore) * 100),
            missingSections: sections.filter(s => !s.data || (typeof s.data === 'string' ? s.data.length === 0 : s.data.length === 0)).map(s => s.name)
        };
    }
    
    // Create comprehensive knowledge base
    createComprehensiveKnowledgeBase(cvData) {
        const kb = {
            // Personal information with analysis
            personal: {
                name: cvData.name,
                headline: cvData.headline,
                about: cvData.about,
                email: cvData.email,
                phone: cvData.phone,
                location: cvData.location,
                fullName: this.extractFullName(cvData.name),
                initials: this.getInitials(cvData.name)
            },
            
            // Enhanced skills analysis
            skills: {
                all: cvData.skills || [],
                technical: this.categorizeSkills(cvData.skills, 'technical'),
                soft: this.categorizeSkills(cvData.skills, 'soft'),
                tools: this.categorizeSkills(cvData.skills, 'tools'),
                languages: this.categorizeSkills(cvData.skills, 'languages'),
                frameworks: this.categorizeSkills(cvData.skills, 'frameworks'),
                databases: this.categorizeSkills(cvData.skills, 'databases'),
                count: (cvData.skills || []).length,
                proficiency: this.assessSkillProficiency(cvData.skills)
            },
            
            // Comprehensive experience analysis
            experience: {
                positions: cvData.experience || [],
                totalPositions: (cvData.experience || []).length,
                companies: (cvData.experience || []).map(exp => exp.company).filter(Boolean),
                titles: (cvData.experience || []).map(exp => exp.title).filter(Boolean),
                years: this.extractYearsOfExperience(cvData.experience),
                totalYears: this.calculateTotalYears(cvData.experience),
                careerProgression: this.analyzeCareerProgression(cvData.experience),
                industries: this.extractIndustries(cvData.experience)
            },
            
            // Detailed projects analysis
            projects: {
                all: cvData.projects || [],
                count: (cvData.projects || []).length,
                technologies: this.getAllTechnologies(cvData.projects),
                projectTypes: this.categorizeProjects(cvData.projects),
                complexity: this.assessProjectComplexity(cvData.projects),
                businessImpact: this.assessBusinessImpact(cvData.projects)
            },
            
            // Enhanced education analysis
            education: {
                degrees: cvData.education || [],
                highestDegree: this.getHighestDegree(cvData.education),
                institutions: (cvData.education || []).map(edu => edu.school).filter(Boolean),
                totalYears: this.calculateEducationYears(cvData.education),
                fieldOfStudy: this.extractFieldsOfStudy(cvData.education),
                achievements: this.extractEducationAchievements(cvData.education)
            }
        };
        
        return kb;
    }
    
    // Enhanced skill categorization
    categorizeSkills(skills, category) {
        if (!skills) return [];
        
        const categories = {
            technical: ['javascript', 'python', 'java', 'react', 'angular', 'vue', 'nodejs', 'typescript', 'php', 'ruby', 'go', 'rust', 'c++', 'c#', 'swift', 'kotlin'],
            soft: ['communication', 'leadership', 'teamwork', 'management', 'problem solving', 'critical thinking', 'creativity', 'adaptability', 'time management', 'collaboration'],
            tools: ['git', 'docker', 'kubernetes', 'jenkins', 'aws', 'azure', 'gcp', 'figma', 'photoshop', 'illustrator', 'excel', 'powerpoint'],
            languages: ['english', 'spanish', 'french', 'german', 'chinese', 'japanese', 'hindi', 'arabic'],
            frameworks: ['react', 'angular', 'vue', 'django', 'flask', 'spring', 'express', 'laravel', 'rails', 'nextjs', 'nuxtjs'],
            databases: ['mysql', 'postgresql', 'mongodb', 'redis', 'elasticsearch', 'cassandra', 'oracle', 'sql server']
        };
        
        const categoryKeywords = categories[category] || [];
        return skills.filter(skill => 
            categoryKeywords.some(keyword => 
                skill.toLowerCase().includes(keyword.toLowerCase())
            )
        );
    }
    
    // Assess skill proficiency based on context
    assessSkillProficiency(skills) {
        if (!skills) return {};
        
        const proficiency = {};
        skills.forEach(skill => {
            // Simple heuristic based on skill mention frequency and context
            const skillLower = skill.toLowerCase();
            if (skillLower.includes('senior') || skillLower.includes('lead') || skillLower.includes('expert')) {
                proficiency[skill] = 'Expert';
            } else if (skillLower.includes('junior') || skillLower.includes('entry')) {
                proficiency[skill] = 'Beginner';
            } else {
                proficiency[skill] = 'Intermediate';
            }
        });
        return proficiency;
    }
    
    // Extract full name components
    extractFullName(name) {
        if (!name) return { first: '', last: '', full: '' };
        const parts = name.trim().split(' ');
        return {
            first: parts[0] || '',
            last: parts.slice(1).join(' ') || '',
            full: name
        };
    }
    
    // Get initials
    getInitials(name) {
        if (!name) return '';
        return name.trim().split(' ').map(part => part[0]).join('').toUpperCase().slice(0, 2);
    }
    
    // Calculate total years of experience
    calculateTotalYears(experience) {
        if (!experience || experience.length === 0) return 0;
        
        const years = this.extractYearsOfExperience(experience);
        let totalYears = 0;
        
        years.forEach(year => {
            totalYears += year.end - year.start;
        });
        
        return Math.round(totalYears * 10) / 10; // Round to 1 decimal place
    }
    
    // Analyze career progression
    analyzeCareerProgression(experience) {
        if (!experience || experience.length === 0) return { progression: 'No data', trend: 'unknown' };
        
        const titles = experience.map(exp => exp.title).filter(Boolean);
        const companies = experience.map(exp => exp.company).filter(Boolean);
        
        // Simple progression analysis
        let progression = 'stable';
        let trend = 'neutral';
        
        if (titles.length > 1) {
            const firstTitle = titles[0].toLowerCase();
            const lastTitle = titles[titles.length - 1].toLowerCase();
            
            if (firstTitle.includes('junior') && lastTitle.includes('senior')) {
                progression = 'upward';
                trend = 'positive';
            } else if (firstTitle.includes('senior') && lastTitle.includes('junior')) {
                progression = 'downward';
                trend = 'negative';
            } else if (firstTitle.includes('developer') && lastTitle.includes('lead')) {
                progression = 'leadership';
                trend = 'positive';
            }
        }
        
        return {
            progression,
            trend,
            jobChanges: companies.length - 1,
            averageTenure: this.calculateAverageTenure(experience)
        };
    }
    
    // Calculate average tenure
    calculateAverageTenure(experience) {
        if (!experience || experience.length === 0) return 0;
        
        const years = this.extractYearsOfExperience(experience);
        if (years.length === 0) return 0;
        
        const totalYears = years.reduce((sum, year) => sum + (year.end - year.start), 0);
        return Math.round((totalYears / years.length) * 10) / 10;
    }
    
    // Extract industries from experience
    extractIndustries(experience) {
        if (!experience) return [];
        
        const industries = new Set();
        const industryKeywords = {
            'technology': ['software', 'tech', 'it', 'computer', 'digital'],
            'finance': ['bank', 'financial', 'investment', 'insurance'],
            'healthcare': ['hospital', 'medical', 'health', 'pharmaceutical'],
            'education': ['school', 'university', 'college', 'education'],
            'retail': ['store', 'shop', 'retail', 'sales'],
            'manufacturing': ['factory', 'production', 'manufacturing'],
            'consulting': ['consultant', 'consulting', 'advisory']
        };
        
        experience.forEach(exp => {
            if (exp.company) {
                const companyLower = exp.company.toLowerCase();
                Object.entries(industryKeywords).forEach(([industry, keywords]) => {
                    if (keywords.some(keyword => companyLower.includes(keyword))) {
                        industries.add(industry);
                    }
                });
            }
        });
        
        return Array.from(industries);
    }
    
    // Assess project complexity
    assessProjectComplexity(projects) {
        if (!projects || projects.length === 0) return { average: 'unknown', distribution: {} };
        
        const complexityScores = projects.map(project => {
            let score = 0;
            const techs = project.technologies || [];
            
            // Complexity based on technology stack
            if (techs.length > 5) score += 3;
            else if (techs.length > 3) score += 2;
            else score += 1;
            
            // Additional complexity indicators
            if (techs.some(tech => tech.toLowerCase().includes('microservice'))) score += 2;
            if (techs.some(tech => tech.toLowerCase().includes('cloud'))) score += 2;
            if (techs.some(tech => tech.toLowerCase().includes('ai') || tech.toLowerCase().includes('ml'))) score += 2;
            
            return score;
        });
        
        const averageScore = complexityScores.reduce((sum, score) => sum + score, 0) / complexityScores.length;
        
        let complexity = 'simple';
        if (averageScore > 6) complexity = 'complex';
        else if (averageScore > 3) complexity = 'moderate';
        
        return {
            average: complexity,
            averageScore: Math.round(averageScore * 10) / 10,
            distribution: {
                simple: complexityScores.filter(s => s <= 3).length,
                moderate: complexityScores.filter(s => s > 3 && s <= 6).length,
                complex: complexityScores.filter(s => s > 6).length
            }
        };
    }
    
    // Assess business impact of projects
    assessBusinessImpact(projects) {
        if (!projects || projects.length === 0) return { high: 0, medium: 0, low: 0 };
        
        const impact = { high: 0, medium: 0, low: 0 };
        
        projects.forEach(project => {
            const description = (project.description || '').toLowerCase();
            let score = 0;
            
            // Impact indicators
            if (description.includes('revenue') || description.includes('sales') || description.includes('profit')) score += 3;
            if (description.includes('users') || description.includes('customers') || description.includes('clients')) score += 2;
            if (description.includes('efficiency') || description.includes('productivity') || description.includes('cost')) score += 2;
            if (description.includes('award') || description.includes('recognition') || description.includes('success')) score += 1;
            
            if (score >= 5) impact.high++;
            else if (score >= 2) impact.medium++;
            else impact.low++;
        });
        
        return impact;
    }
    
    // Calculate education years
    calculateEducationYears(education) {
        if (!education || education.length === 0) return 0;
        
        let totalYears = 0;
        education.forEach(edu => {
            const period = edu.period || '';
            const yearMatch = period.match(/\d{4}/g);
            if (yearMatch && yearMatch.length >= 2) {
                const start = parseInt(yearMatch[0]);
                const end = parseInt(yearMatch[1]);
                totalYears += end - start;
            }
        });
        
        return totalYears;
    }
    
    // Extract fields of study
    extractFieldsOfStudy(education) {
        if (!education) return [];
        
        const fields = new Set();
        const fieldKeywords = {
            'Computer Science': ['computer', 'software', 'programming', 'cs'],
            'Business': ['business', 'management', 'marketing', 'finance'],
            'Engineering': ['engineering', 'mechanical', 'electrical', 'civil'],
            'Arts': ['arts', 'design', 'creative', 'visual'],
            'Science': ['science', 'biology', 'chemistry', 'physics'],
            'Mathematics': ['mathematics', 'math', 'statistics']
        };
        
        education.forEach(edu => {
            if (edu.degree) {
                const degreeLower = edu.degree.toLowerCase();
                Object.entries(fieldKeywords).forEach(([field, keywords]) => {
                    if (keywords.some(keyword => degreeLower.includes(keyword))) {
                        fields.add(field);
                    }
                });
            }
        });
        
        return Array.from(fields);
    }
    
    // Extract education achievements
    extractEducationAchievements(education) {
        if (!education) return [];
        
        const achievements = [];
        education.forEach(edu => {
            if (edu.degree) {
                const degreeLower = edu.degree.toLowerCase();
                if (degreeLower.includes('honor') || degreeLower.includes('distinction') || degreeLower.includes('magna')) {
                    achievements.push('Academic Honors');
                }
                if (degreeLower.includes('master') || degreeLower.includes('phd')) {
                    achievements.push('Advanced Degree');
                }
            }
        });
        
        return [...new Set(achievements)];
    }
    
    // Extract years of experience from experience data
    extractYearsOfExperience(experience) {
        const years = [];
        experience.forEach(exp => {
            const period = exp.period;
            const yearMatch = period.match(/\d{4}/g);
            if (yearMatch && yearMatch.length >= 2) {
                years.push({
                    start: parseInt(yearMatch[0]),
                    end: yearMatch[1] === 'present' ? new Date().getFullYear() : parseInt(yearMatch[1])
                });
            }
        });
        return years;
    }
    
    // Get all technologies from projects
    getAllTechnologies(projects) {
        const allTechs = new Set();
        projects.forEach(project => {
            project.technologies.forEach(tech => allTechs.add(tech));
        });
        return Array.from(allTechs);
    }
    
    // Categorize projects by type
    categorizeProjects(projects) {
        const categories = {
            web: [],
            mobile: [],
            desktop: [],
            other: []
        };
        
        projects.forEach(project => {
            const techs = project.technologies.join(' ').toLowerCase();
            if (techs.includes('react') || techs.includes('angular') || techs.includes('vue') || techs.includes('html')) {
                categories.web.push(project);
            } else if (techs.includes('android') || techs.includes('ios') || techs.includes('mobile')) {
                categories.mobile.push(project);
            } else if (techs.includes('desktop') || techs.includes('electron') || techs.includes('java')) {
                categories.desktop.push(project);
            } else {
                categories.other.push(project);
            }
        });
        
        return categories;
    }
    
    // Get highest degree from education
    getHighestDegree(education) {
        const degreeHierarchy = ['phd', 'master', 'bachelor', 'associate', 'diploma'];
        let highest = null;
        let highestIndex = -1;
        
        education.forEach(edu => {
            const degree = edu.degree.toLowerCase();
            degreeHierarchy.forEach((level, index) => {
                if (degree.includes(level) && index > highestIndex) {
                    highest = edu.degree;
                    highestIndex = index;
                }
            });
        });
        
        return highest || education[0]?.degree || 'Degree';
    }
    
    async answerQuestion(question, cvData, tone) {
        // Try to load pre-trained data first
        if (!this.isFullyTrained || !this.trainingData) {
            this.loadTrainingData(cvData.portfolioId || 'default');
        }
        
        // Train with current CV data if not already trained
        if (!this.isFullyTrained) {
            this.trainWithCVData(cvData, cvData.portfolioId || 'default');
        }
        
        const responses = this.responses[tone] || this.responses.friendly;
        const lowerQuestion = question.toLowerCase();
        const kb = this.trainingData.knowledgeBase;
        
        console.log(`🤖 Answering question: "${question}" with trained data for ${this.trainingData.name}`);
        
        // Personal information questions
        if (lowerQuestion.includes('who are you') || lowerQuestion.includes('tell me about') || lowerQuestion.includes('about you')) {
            return this.getPersonalSummary(tone);
        }
        
        // Name questions
        if (lowerQuestion.includes('what is your name') || lowerQuestion.includes('what\'s your name')) {
            return `${this.getToneSpecificResponse('name', tone)} ${kb.personal.name}.`;
        }
        
        // Skills-related questions
        if (lowerQuestion.includes('skill') || lowerQuestion.includes('what can you do') || lowerQuestion.includes('technologies') || lowerQuestion.includes('programming')) {
            return this.getSkillsResponse(kb, tone, question);
        }
        
        // Experience-related questions
        if (lowerQuestion.includes('experience') || lowerQuestion.includes('work') || lowerQuestion.includes('job') || lowerQuestion.includes('career')) {
            return this.getExperienceResponse(kb, tone, question);
        }
        
        // Project-related questions
        if (lowerQuestion.includes('project') || lowerQuestion.includes('built') || lowerQuestion.includes('created') || lowerQuestion.includes('developed')) {
            return this.getProjectsResponse(kb, tone, question);
        }
        
        // Education-related questions
        if (lowerQuestion.includes('education') || lowerQuestion.includes('degree') || lowerQuestion.includes('school') || lowerQuestion.includes('university') || lowerQuestion.includes('college')) {
            return this.getEducationResponse(kb, tone, question);
        }
        
        // Contact-related questions
        if (lowerQuestion.includes('contact') || lowerQuestion.includes('email') || lowerQuestion.includes('phone') || lowerQuestion.includes('reach')) {
            return this.getContactResponse(kb, tone);
        }
        
        // Portfolio improvement questions
        if (lowerQuestion.includes('improve') || lowerQuestion.includes('better') || lowerQuestion.includes('suggestion') || lowerQuestion.includes('enhance')) {
            return this.getPortfolioImprovement(cvData, tone, responses.improvement);
        }
        
        // Years of experience questions
        if (lowerQuestion.includes('how many years') || lowerQuestion.includes('years of experience')) {
            return this.getYearsOfExperienceResponse(kb, tone);
        }
        
        // Company questions
        if (lowerQuestion.includes('company') || lowerQuestion.includes('companies') || lowerQuestion.includes('where have you worked')) {
            return this.getCompaniesResponse(kb, tone);
        }
        
        // Technology-specific questions
        if (lowerQuestion.includes('javascript') || lowerQuestion.includes('python') || lowerQuestion.includes('java') || lowerQuestion.includes('react')) {
            return this.getTechnologySpecificResponse(kb, tone, question);
        }
        
        // Career progression questions
        if (lowerQuestion.includes('career progression') || lowerQuestion.includes('career growth') || lowerQuestion.includes('promotion')) {
            return this.getCareerProgressionResponse(kb, tone);
        }
        
        // Industry questions
        if (lowerQuestion.includes('industry') || lowerQuestion.includes('sector') || lowerQuestion.includes('field')) {
            return this.getIndustryResponse(kb, tone);
        }
        
        // Project complexity questions
        if (lowerQuestion.includes('complex') || lowerQuestion.includes('difficulty') || lowerQuestion.includes('challenging')) {
            return this.getProjectComplexityResponse(kb, tone);
        }
        
        // Data completeness questions
        if (lowerQuestion.includes('complete') || lowerQuestion.includes('missing') || lowerQuestion.includes('what\'s missing')) {
            return this.getDataCompletenessResponse(tone);
        }
        
        // Default response
        return `${responses.default}\n\n${this.getGeneralInfo(kb, tone)}`;
    }
    
    getSkillsResponse(kb, tone, question) {
        const responses = this.responses[tone];
        let answer = responses.skills + '\n\n';
        
        // List all skills
        kb.skills.all.forEach(skill => {
            answer += `• ${skill}\n`;
        });
        
        // Add skill breakdown if asked
        if (question.toLowerCase().includes('technical') || question.toLowerCase().includes('programming')) {
            answer += '\n**Technical Skills:**\n';
            kb.skills.technical.forEach(skill => {
                answer += `• ${skill}\n`;
            });
        }
        
        if (question.toLowerCase().includes('soft')) {
            answer += '\n**Soft Skills:**\n';
            kb.skills.soft.forEach(skill => {
                answer += `• ${skill}\n`;
            });
        }
        
        answer += '\n' + this.getSkillsInsight(kb.skills.all, tone);
        return answer;
    }
    
    getExperienceResponse(kb, tone, question) {
        const responses = this.responses[tone];
        let answer = responses.experience + '\n\n';
        
        kb.experience.positions.forEach((exp, index) => {
            answer += `**${exp.title}** at ${exp.company}\n`;
            answer += `${exp.period}\n`;
            answer += `${exp.description}\n\n`;
        });
        
        // Add specific information if asked
        if (question.toLowerCase().includes('how many') || question.toLowerCase().includes('total')) {
            answer += `**Total Positions:** ${kb.experience.totalPositions}\n`;
            answer += `**Companies Worked With:** ${kb.experience.companies.join(', ')}\n\n`;
        }
        
        return answer + this.getExperienceInsight(kb.experience.positions, tone);
    }
    
    getProjectsResponse(kb, tone, question) {
        const responses = this.responses[tone];
        let answer = responses.projects + '\n\n';
        
        kb.projects.all.forEach((project, index) => {
            answer += `**${project.name}**\n`;
            answer += `${project.description}\n`;
            answer += `Technologies: ${project.technologies.join(', ')}\n\n`;
        });
        
        // Add project statistics if asked
        if (question.toLowerCase().includes('how many') || question.toLowerCase().includes('total')) {
            answer += `**Total Projects:** ${kb.projects.count}\n`;
            answer += `**All Technologies Used:** ${kb.projects.technologies.join(', ')}\n\n`;
        }
        
        return answer + this.getProjectInsight(kb.projects.all, tone);
    }
    
    getEducationResponse(kb, tone, question) {
        const responses = this.responses[tone];
        let answer = responses.education + '\n\n';
        
        kb.education.degrees.forEach((edu, index) => {
            answer += `**${edu.degree}**\n`;
            answer += `${edu.school}\n`;
            answer += `${edu.period}\n\n`;
        });
        
        // Add highest degree information
        answer += `**Highest Degree:** ${kb.education.highestDegree}\n`;
        answer += `**Institutions Attended:** ${kb.education.institutions.join(', ')}\n`;
        
        return answer;
    }
    
    getContactResponse(kb, tone) {
        const responses = this.responses[tone];
        return `${responses.contact}\n\n📧 Email: ${kb.personal.email}\n📱 Phone: ${kb.personal.phone}\n📍 Location: ${kb.personal.location}`;
    }
    
    getYearsOfExperienceResponse(kb, tone) {
        const years = kb.experience.years;
        let totalYears = 0;
        
        years.forEach(year => {
            totalYears += year.end - year.start;
        });
        
        const responses = {
            friendly: `You have approximately ${totalYears} years of professional experience! That's pretty impressive! 🎉`,
            professional: `Based on your work history, you possess approximately ${totalYears} years of professional experience.`,
            formal: `Your curriculum vitae indicates approximately ${totalYears} years of cumulative professional experience.`
        };
        
        return responses[tone] || responses.friendly;
    }
    
    getCompaniesResponse(kb, tone) {
        const companies = kb.experience.companies;
        const responses = {
            friendly: `You've worked at some great places! Here's where: ${companies.join(', ')}`,
            professional: `Your professional experience includes the following organizations: ${companies.join(', ')}`,
            formal: `Your employment history encompasses the following institutions: ${companies.join(', ')}`
        };
        
        return responses[tone] || responses.friendly;
    }
    
    getTechnologySpecificResponse(kb, tone, question) {
        const allTechs = [...kb.skills.all, ...kb.projects.technologies];
        const mentionedTech = allTechs.find(tech => 
            question.toLowerCase().includes(tech.toLowerCase())
        );
        
        if (mentionedTech) {
            const responses = {
                friendly: `Yes! You have experience with ${mentionedTech}. It's one of your key technologies! 🚀`,
                professional: `Indeed, ${mentionedTech} is included in your technical skill set and project experience.`,
                formal: `${mentionedTech} is confirmed as part of your technical competencies and project portfolio.`
            };
            return responses[tone] || responses.friendly;
        }
        
        return this.getSkillsResponse(kb, tone, question);
    }
    
    getToneSpecificResponse(type, tone) {
        const responses = {
            name: {
                friendly: "You're ",
                professional: "The individual is ",
                formal: "The candidate is "
            }
        };
        return responses[type]?.[tone] || responses.name.friendly;
    }
    
    getPersonalSummary(tone) {
        const kb = this.trainedData.knowledgeBase;
        const summaries = {
            friendly: `You're ${kb.personal.name}, a ${kb.personal.headline}! ${kb.personal.about} Pretty impressive, right? 😊`,
            professional: `${kb.personal.name} is a ${kb.personal.headline}. ${kb.personal.about} This professional profile demonstrates strong capabilities and expertise.`,
            formal: `${kb.personal.name} holds the position of ${kb.personal.headline}. ${kb.personal.about} The curriculum vitae reflects a high level of professional competence.`
        };
        return summaries[tone] || summaries.friendly;
    }
    
    getGeneralInfo(kb, tone) {
        const info = {
            friendly: `Based on your CV, ${kb.personal.name} is a ${kb.personal.headline} with expertise in ${kb.skills.all.slice(0, 3).join(', ')}. Is there something specific you'd like to know?`,
            professional: `${kb.personal.name} is a ${kb.personal.headline} with demonstrated expertise in ${kb.skills.all.slice(0, 3).join(', ')}. How may I assist you further?`,
            formal: `${kb.personal.name} holds the professional designation of ${kb.personal.headline}, with expertise encompassing ${kb.skills.all.slice(0, 3).join(', ')}. Please specify your inquiry for detailed information.`
        };
        return info[tone] || info.friendly;
    }
    
    getSkillsInsight(skills, tone) {
        const insights = {
            friendly: "You've got a well-rounded skill set! These technologies are in high demand right now. Keep up the great work! 🚀",
            professional: "Your technical competencies align well with current industry demands. This combination of skills positions you favorably in the job market.",
            formal: "Your skill set demonstrates comprehensive technical proficiency across multiple domains, which is highly valued in contemporary professional environments."
        };
        return insights[tone] || insights.friendly;
    }
    
    getExperienceInsight(experience, tone) {
        const insights = {
            friendly: "Your work experience shows a clear progression and growth! You've built some impressive expertise over the years. 👏",
            professional: "Your professional trajectory demonstrates consistent career advancement and expanding responsibilities.",
            formal: "Your employment history reflects a pattern of progressive professional development and increasing scope of responsibilities."
        };
        return insights[tone] || insights.friendly;
    }
    
    getProjectInsight(projects, tone) {
        const insights = {
            friendly: "These projects show you can apply your skills to real-world challenges! That's exactly what employers love to see! 💪",
            professional: "Your project portfolio demonstrates practical application of technical skills and problem-solving capabilities.",
            formal: "The projects in your portfolio evidence your ability to translate theoretical knowledge into practical solutions."
        };
        return insights[tone] || insights.friendly;
    }
    
    getPortfolioImprovement(cvData, tone, prefix) {
        const suggestions = [];
        
        if (cvData.skills.length < 5) {
            suggestions.push("Consider adding more technical skills to showcase your full range of abilities");
        }
        
        if (cvData.projects.length < 2) {
            suggestions.push("Adding more projects would strengthen your portfolio and demonstrate diverse experience");
        }
        
        if (cvData.about.length < 100) {
            suggestions.push("Consider expanding your about section to better highlight your unique value proposition");
        }
        
        if (suggestions.length === 0) {
            suggestions.push("Your portfolio looks comprehensive! Consider adding quantifiable achievements to make it even stronger");
        }
        
        const suggestionText = suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n');
        
        const endings = {
            friendly: "These tweaks will help make your portfolio stand out even more! ✨",
            professional: "Implementing these enhancements will strengthen your professional presentation.",
            formal: "These recommendations are intended to optimize your portfolio's effectiveness."
        };
        
        return `${prefix}\n\n${suggestionText}\n\n${endings[tone] || endings.friendly}`;
    }
    
    getCareerAdvice(cvData, tone) {
        const advice = {
            friendly: "Based on your CV, you're on a great career path! Consider leveraging your skills to take on more challenging projects. Your experience shows you're ready for the next level! 🌟",
            professional: "Your professional background suggests you're well-positioned for career advancement. Consider seeking opportunities that align with your demonstrated expertise.",
            formal: "Given your professional qualifications and experience, you are appropriately positioned for career progression within your field of expertise."
        };
        return advice[tone] || advice.friendly;
    }
    
    // New response methods for enhanced training
    getCareerProgressionResponse(kb, tone) {
        const progression = kb.experience.careerProgression;
        const responses = {
            friendly: `Your career shows ${progression.progression} progression! You've had ${progression.jobChanges} job changes with an average tenure of ${progression.averageTenure} years. ${progression.trend === 'positive' ? 'That\'s great growth! 📈' : ''}`,
            professional: `Your career trajectory indicates ${progression.progression} progression with ${progression.jobChanges} position changes and an average tenure of ${progression.averageTenure} years.`,
            formal: `Your employment history demonstrates ${progression.progression} progression, encompassing ${progression.jobChanges} role transitions with an average tenure duration of ${progression.averageTenure} years.`
        };
        return responses[tone] || responses.friendly;
    }
    
    getIndustryResponse(kb, tone) {
        const industries = kb.experience.industries;
        const responses = {
            friendly: `You've worked across ${industries.length} industries: ${industries.join(', ')}! That's diverse experience! 🌍`,
            professional: `Your professional experience spans ${industries.length} industry sectors: ${industries.join(', ')}.`,
            formal: `Your employment history encompasses experience across ${industries.length} industry sectors: ${industries.join(', ')}.`
        };
        return responses[tone] || responses.friendly;
    }
    
    getProjectComplexityResponse(kb, tone) {
        const complexity = kb.projects.complexity;
        const responses = {
            friendly: `Your projects are mainly ${complexity.average} in complexity! You've worked on ${complexity.distribution.simple} simple, ${complexity.distribution.moderate} moderate, and ${complexity.distribution.complex} complex projects. Pretty impressive! 🚀`,
            professional: `Your project portfolio demonstrates ${complexity.average} complexity, with ${complexity.distribution.simple} simple, ${complexity.distribution.moderate} moderate, and ${complexity.distribution.complex} complex undertakings.`,
            formal: `Your project portfolio exhibits ${complexity.average} complexity, comprising ${complexity.distribution.simple} basic, ${complexity.distribution.moderate} intermediate, and ${complexity.distribution.complex} advanced projects.`
        };
        return responses[tone] || responses.friendly;
    }
    
    getDataCompletenessResponse(tone) {
        const completeness = this.trainingData.dataCompleteness;
        const responses = {
            friendly: `Your CV is ${completeness.score}% complete! Missing sections: ${completeness.missingSections.join(', ')}. Adding these would make your profile even stronger! 💪`,
            professional: `Your curriculum vitae is ${completeness.score}% complete. The following sections require attention: ${completeness.missingSections.join(', ')}.`,
            formal: `Your curriculum vitae completeness is assessed at ${completeness.score}%. The following sections are recommended for inclusion: ${completeness.missingSections.join(', ')}.`
        };
        return responses[tone] || responses.friendly;
    }
}

const cvChatbot = new CVChatbot();

// Start server
app.listen(PORT, () => {
    console.log(`🚀 PortfolioForge API server running on port ${PORT}`);
    console.log(`📊 MongoDB connected`);
    console.log(`🤖 Kyro AI (CV Assistant) with full multilingual capabilities enabled`);
    console.log(`🌐 Frontend available at: http://localhost:${PORT}`);
    console.log(`📁 API endpoints:`);
    console.log(`   POST /api/upload - Upload and process resume`);
    console.log(`   GET  /api/portfolio/:id - Get portfolio data`);
    console.log(`   PUT  /api/portfolio/:id - Update portfolio`);
    console.log(`   POST /api/chatbot - Kyro AI - Advanced multilingual CV assistant`);
    console.log(`   GET  /portfolio/:id - View generated portfolio`);
});
