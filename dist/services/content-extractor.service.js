import axios from 'axios';
import * as cheerio from 'cheerio';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import MarkdownIt from 'markdown-it';
import TurndownService from 'turndown';
export class ContentExtractor {
    md;
    turndownService;
    // Cache for webpage content (key: url + format, value: content)
    contentCache = new Map();
    // Cache expiration time in milliseconds (30 minutes)
    cacheTTL = 30 * 60 * 1000;
    constructor() {
        this.md = new MarkdownIt();
        this.turndownService = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced'
        });
    }
    cleanText(text) {
        // Remove multiple blank lines
        text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
        // Remove excessive spaces
        text = text.replace(/ +/g, ' ');
        return text.trim();
    }
    cleanMarkdown(text) {
        let cleanedText = this.cleanText(text);
        // Ensure headers have space after #
        cleanedText = cleanedText.replace(/#([A-Za-z0-9])/g, '# $1');
        return cleanedText;
    }
    htmlToMarkdown(html) {
        return this.cleanMarkdown(this.turndownService.turndown(html));
    }
    htmlToPlainText(html) {
        const dom = new JSDOM(html);
        return this.cleanText(dom.window.document.body.textContent || '');
    }
    isValidUrl(url) {
        try {
            new URL(url);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Generate a cache key from URL and format
     */
    generateCacheKey(url, format) {
        return `${url}|${format}`;
    }
    /**
     * Check if a cache entry is still valid
     */
    isCacheValid(entry) {
        const now = Date.now();
        return now - entry.timestamp < this.cacheTTL;
    }
    /**
     * Store webpage content in cache
     */
    cacheContent(url, format, content) {
        const cacheKey = this.generateCacheKey(url, format);
        this.contentCache.set(cacheKey, {
            timestamp: Date.now(),
            content
        });
        // Limit cache size to prevent memory issues (max 50 entries)
        if (this.contentCache.size > 50) {
            // Delete oldest entry
            const oldestKey = Array.from(this.contentCache.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp)[0][0];
            this.contentCache.delete(oldestKey);
        }
    }
    /**
     * Generates a concise summary of the content
     * @param content The content to summarize
     * @param maxLength Maximum length of the summary
     * @returns A summary of the content
     */
    generateSummary(content, maxLength = 300) {
        // Simple summarization: take first few sentences up to maxLength
        const sentences = content.split(/(?<=[.!?])\s+/);
        let summary = '';
        for (const sentence of sentences) {
            if ((summary + sentence).length <= maxLength) {
                summary += sentence + ' ';
            }
            else {
                break;
            }
        }
        return summary.trim() + (summary.length < content.length ? '...' : '');
    }
    async extractContent(url, format = 'markdown') {
        if (!this.isValidUrl(url)) {
            throw new Error('Invalid URL provided');
        }
        // Check cache first
        const cacheKey = this.generateCacheKey(url, format);
        const cachedContent = this.contentCache.get(cacheKey);
        if (cachedContent && this.isCacheValid(cachedContent)) {
            console.error(`Using cached content for ${url}`);
            return cachedContent.content;
        }
        try {
            // Fetch webpage content
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                timeout: 10000
            });
            // Parse with Cheerio for metadata
            const $ = cheerio.load(response.data);
            const metaTags = {};
            // Only extract the most important meta tags to reduce data volume
            const importantMetaTags = ['description', 'keywords', 'author', 'og:title', 'og:description', 'twitter:title', 'twitter:description'];
            $('meta').each((_, element) => {
                const name = $(element).attr('name') || $(element).attr('property') || '';
                const content = $(element).attr('content') || '';
                if (name && content && importantMetaTags.some(tag => name.includes(tag))) {
                    metaTags[name] = content;
                }
            });
            // Use Readability for main content extraction
            const dom = new JSDOM(response.data);
            const reader = new Readability(dom.window.document);
            const article = reader.parse();
            if (!article) {
                throw new Error('Failed to extract content from webpage');
            }
            // Convert content based on requested format
            let contentStr;
            switch (format) {
                case 'html':
                    contentStr = article.content || '';
                    break;
                case 'text':
                    contentStr = this.htmlToPlainText(article.content || '');
                    break;
                case 'markdown':
                default:
                    contentStr = this.htmlToMarkdown(article.content || '');
                    break;
            }
            // Calculate content stats
            const wordCount = contentStr.split(/\s+/).filter(word => word.length > 0).length;
            // Generate a summary of the content
            const summary = this.generateSummary(contentStr);
            const content = {
                url,
                title: $('title').text() || article.title || '',
                description: metaTags['description'] || '',
                content: contentStr,
                format: format,
                meta_tags: metaTags,
                stats: {
                    word_count: wordCount,
                    approximate_chars: contentStr.length
                },
                content_preview: {
                    first_500_chars: contentStr.slice(0, 500) + (contentStr.length > 500 ? '...' : '')
                },
                summary: summary
            };
            // Cache the content before returning
            this.cacheContent(url, format, content);
            return content;
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                throw new Error(`Failed to fetch webpage: ${error.message}`);
            }
            throw error;
        }
    }
    async batchExtractContent(urls, format = 'markdown') {
        const results = {};
        await Promise.all(urls.map(async (url) => {
            try {
                results[url] = await this.extractContent(url, format);
            }
            catch (error) {
                results[url] = {
                    error: error instanceof Error ? error.message : 'Unknown error occurred'
                };
            }
        }));
        return results;
    }
}
