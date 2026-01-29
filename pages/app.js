// Load patterns from JSON file
let allPatterns = [];
let filteredPatterns = [];

// Difficulty labels in English
const difficultyLabels = {
    'beginner': 'Beginner',
    'intermediate': 'Intermediate',
    'advanced': 'Advanced'
};

// Load patterns on page load
async function loadPatterns() {
    try {
        const response = await fetch('patterns.json');
        allPatterns = await response.json();
        
        // Sort patterns by date in descending order (newest first)
        allPatterns.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        filteredPatterns = [...allPatterns];
        
        // Populate tag filter
        populateTagFilter();
        
        // Render patterns
        renderPatterns();
        
        // Setup event listeners
        setupEventListeners();
    } catch (error) {
        console.error('Error loading patterns:', error);
        document.getElementById('patternsGrid').innerHTML = 
            '<div class="col-span-full text-center text-red-500">Failed to load patterns</div>';
    }
}

// Populate tag filter dropdown
function populateTagFilter() {
    const tags = new Set();
    allPatterns.forEach(pattern => {
        pattern.tags.forEach(tag => tags.add(tag));
    });
    
    const tagFilter = document.getElementById('tagFilter');
    tags.forEach(tag => {
        const option = document.createElement('option');
        option.value = tag;
        option.textContent = tag;
        tagFilter.appendChild(option);
    });
}

// Render pattern cards
function renderPatterns() {
    const grid = document.getElementById('patternsGrid');
    const noResults = document.getElementById('noResults');
    const patternCount = document.getElementById('patternCount');
    
    if (filteredPatterns.length === 0) {
        grid.classList.add('hidden');
        noResults.classList.remove('hidden');
        patternCount.textContent = '0';
        return;
    }
    
    grid.classList.remove('hidden');
    noResults.classList.add('hidden');
    patternCount.textContent = filteredPatterns.length;
    
    grid.innerHTML = filteredPatterns.map(pattern => createPatternCard(pattern)).join('');
}

// Create a pattern card HTML
function createPatternCard(pattern) {
    const tags = pattern.tags.map(tag => 
        `<span class="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded">${tag}</span>`
    ).join('');
    
    const difficultyClass = `difficulty-${pattern.difficulty}`;
    const difficultyLabel = difficultyLabels[pattern.difficulty] || pattern.difficulty;
    
    // Image HTML
    const imageHTML = pattern.image 
        ? `<div class="pattern-image-container mb-4">
               <img src="${pattern.image}" alt="${pattern.title}" class="pattern-image" onerror="this.style.display='none'">
           </div>`
        : '';
    
    // Article links HTML
    const articleLinksHTML = createArticleLinksHTML(pattern.articles);
    
    return `
        <div class="pattern-card bg-white rounded-lg shadow-md overflow-hidden border border-gray-200">
            <div class="pattern-card-content">
                <!-- Pattern Image -->
                ${imageHTML}
                
                <!-- Difficulty Badge -->
                <div class="mb-3">
                    <span class="difficulty-badge ${difficultyClass}">${difficultyLabel}</span>
                </div>
                
                <div class="pattern-card-body">
                    <!-- Title and Description -->
                    <h3 class="text-lg font-bold text-gray-900 mb-2">${pattern.title}</h3>
                    <p class="text-gray-600 text-sm mb-4 flex-1">${pattern.description}</p>
                    
                    <!-- Article Links -->
                    ${articleLinksHTML}
                    
                    <!-- Tags -->
                    <div class="flex flex-wrap gap-2 mb-4">
                        ${tags}
                    </div>
                    
                    <!-- View Pattern Button -->
                    <a href="${pattern.link}" class="inline-block w-full text-center bg-aws-orange hover:bg-orange-600 text-white font-semibold py-2 px-4 rounded transition">
                        View Pattern
                    </a>
                </div>
            </div>
        </div>
    `;
}

// Create article links HTML
function createArticleLinksHTML(articles) {
    if (!articles) return '';
    
    const links = [];
    
    if (articles.devto) {
        links.push(`<a href="${articles.devto}" target="_blank" rel="noopener noreferrer" class="article-link devto" title="Read on DEV.to">DEV</a>`);
    }
    
    if (articles.zenn) {
        links.push(`<a href="${articles.zenn}" target="_blank" rel="noopener noreferrer" class="article-link zenn" title="Read on Zenn">Z</a>`);
    }
    
    if (articles.qiita) {
        links.push(`<a href="${articles.qiita}" target="_blank" rel="noopener noreferrer" class="article-link qiita" title="Read on Qiita">Q</a>`);
    }
    
    if (links.length === 0) return '';
    
    return `<div class="article-links">${links.join('')}</div>`;
}

// Filter patterns based on search and filters
function filterPatterns() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const difficultyFilter = document.getElementById('difficultyFilter').value;
    const tagFilter = document.getElementById('tagFilter').value;
    
    filteredPatterns = allPatterns.filter(pattern => {
        // Search filter
        const matchesSearch = !searchTerm || 
            pattern.title.toLowerCase().includes(searchTerm) ||
            pattern.description.toLowerCase().includes(searchTerm) ||
            pattern.tags.some(tag => tag.toLowerCase().includes(searchTerm));
        
        // Difficulty filter
        const matchesDifficulty = !difficultyFilter || pattern.difficulty === difficultyFilter;
        
        // Tag filter
        const matchesTag = !tagFilter || pattern.tags.includes(tagFilter);
        
        return matchesSearch && matchesDifficulty && matchesTag;
    });
    
    renderPatterns();
}

// Setup event listeners
function setupEventListeners() {
    document.getElementById('searchInput').addEventListener('input', filterPatterns);
    document.getElementById('difficultyFilter').addEventListener('change', filterPatterns);
    document.getElementById('tagFilter').addEventListener('change', filterPatterns);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', loadPatterns);
