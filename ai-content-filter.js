const { GoogleGenerativeAI } = require('@google/generative-ai')

// Initialize Gemini AI
const genAI = process.env.GEMINI_API_KEY ?
  new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null

/**
 * Use AI to extract main article content from mixed content
 */
async function extractMainContent(rawMarkdown, url) {
  if (!genAI) {
    console.warn('Gemini API key not configured for AI content filtering')
    return rawMarkdown
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

    const prompt = `You are a content extraction specialist. Extract ONLY the main article content from the provided markdown, removing all navigation, advertisements, newsletters, social media elements, and website interface elements.

Guidelines:
1. Keep the article title, author, date, and main body text
2. Preserve article headings, paragraphs, quotes, and lists
3. Remove: navigation menus, ads, social sharing buttons, newsletter signups, comments sections, footer content, "Skip to content" links, cookie notices, subscription prompts
4. Remove: "Loading", "Sign up", email forms, reCAPTCHA content, "protected by" text
5. Keep important article links and references
6. Maintain proper markdown formatting
7. If there's minimal actual article content, return just the title and what little content exists

Input URL: ${url}

Raw Content:
${rawMarkdown}

Extract the clean article content in markdown format:`

    const result = await model.generateContent(prompt)
    const response = await result.response
    let cleanContent = response.text()

    // Clean up any AI artifacts
    cleanContent = cleanContent
      .replace(/```markdown\n?/g, '')
      .replace(/```\n?$/g, '')
      .trim()

    // Ensure we have meaningful content
    if (cleanContent.length < 100) {
      console.log('AI filtering resulted in very short content, using original')
      return rawMarkdown
    }

    console.log(`AI content filtering: ${rawMarkdown.length} → ${cleanContent.length} characters`)
    return cleanContent

  } catch (error) {
    console.error('AI content filtering error:', error)
    return rawMarkdown // Fallback to original content
  }
}

/**
 * Post-process content to ensure quality
 */
function postProcessContent(content) {
  // Remove any remaining unwanted patterns
  let cleaned = content
    // Remove standalone social media prompts
    .replace(/^- \[.*?\]\(.*?\)\s*$/gm, '')
    // Remove email subscription remnants
    .replace(/Email\s*Employer\s*Job Title/g, '')
    // Remove excessive whitespace
    .replace(/\n{4,}/g, '\n\n\n')
    // Remove loading states
    .replace(/Loading[\s\S]*?updates/g, '')
    // Remove standalone navigation elements
    .replace(/^(Home|About|Contact|Menu|Navigation)\s*$/gm, '')
    .trim()

  return cleaned
}

/**
 * Validate if content is worth archiving using AI
 */
async function validateContentQuality(content, title, url) {
  if (!genAI) {
    console.warn('Gemini API key not configured for content quality validation')
    return { shouldArchive: true, reason: 'No AI validation available' }
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

    const prompt = `You are a content quality assessor. Determine if this web content should be archived based on its value and quality.

URL: ${url}
Title: ${title}

Content to evaluate:
${content.substring(0, 2000)}${content.length > 2000 ? '...' : ''}

REJECT content if it contains:
- "404", "Page Not Found", "Not Found" messages
- "This page doesn't exist" or similar error messages
- Dead/broken link redirects (bit.ly, t.co redirects to error pages)
- Primarily navigation menus, footers, or website chrome
- Login/signup pages without substantial content
- Empty or near-empty pages
- Cookie notices, privacy policy pages without content
- "Access Denied", "Forbidden", "Unauthorized" messages
- Spam, advertising-only content
- Error pages, maintenance pages
- Pages that are just redirects or link aggregators
- Social media error pages ("This tweet is unavailable")

ACCEPT content if it contains:
- Articles, blog posts, news stories
- Educational or informational content
- Documentation, tutorials, guides
- Research papers, case studies
- Product information with substantial detail
- Forums discussions with meaningful content
- Books, essays, opinion pieces

Respond with JSON only:
{
  "shouldArchive": true/false,
  "reason": "Brief explanation",
  "confidence": 0.0-1.0
}`

    const result = await model.generateContent(prompt)
    const response = await result.response
    let responseText = response.text().trim()

    // Clean up JSON response
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?$/g, '').trim()

    const validation = JSON.parse(responseText)

    console.log(`Content quality validation for ${url}: ${validation.shouldArchive ? 'ACCEPT' : 'REJECT'} - ${validation.reason}`)

    return validation

  } catch (error) {
    console.error('Content quality validation error:', error)
    // On error, default to accepting content to avoid false negatives
    return { shouldArchive: true, reason: 'Validation error, defaulting to accept', confidence: 0.5 }
  }
}

/**
 * Enhanced content extraction with AI filtering and quality validation
 */
async function enhancedContentExtraction(firecrawlResult, url) {
  if (!firecrawlResult || !firecrawlResult.markdown) {
    return firecrawlResult
  }

  try {
    // First, validate if this content should be archived at all
    const validation = await validateContentQuality(
      firecrawlResult.markdown,
      firecrawlResult.title || '',
      url
    )

    if (!validation.shouldArchive) {
      console.log(`🚫 Content rejected: ${validation.reason}`)
      throw new Error(`Content rejected: ${validation.reason}`)
    }

    // Apply AI filtering to extract main content
    const aiFilteredMarkdown = await extractMainContent(firecrawlResult.markdown, url)

    // Post-process the AI-filtered content
    const finalMarkdown = postProcessContent(aiFilteredMarkdown)

    // Extract plain text for search from the filtered content
    const plainText = finalMarkdown
      .replace(/```[\s\S]*?```/g, '') // Remove code blocks
      .replace(/`[^`]*`/g, '') // Remove inline code
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Convert links to text
      .replace(/[#*_`]/g, '') // Remove markdown formatting
      .replace(/\n+/g, ' ') // Replace newlines with spaces
      .trim()

    // Additional quality checks on the final content
    if (plainText.length < 50) {
      throw new Error('Content too short after filtering')
    }

    const wordCount = plainText.split(/\s+/).filter(word => word.length > 0).length
    if (wordCount < 10) {
      throw new Error('Content has too few meaningful words')
    }

    // Update the result with filtered content
    return {
      ...firecrawlResult,
      markdown: finalMarkdown,
      text: plainText,
      wordCount: wordCount,
      readingTime: Math.ceil(wordCount / 200),
      aiFiltered: true,
      qualityValidation: validation
    }

  } catch (error) {
    console.error('Enhanced content extraction error:', error)
    throw error // Re-throw to prevent archiving of rejected content
  }
}

module.exports = {
  extractMainContent,
  postProcessContent,
  enhancedContentExtraction,
  validateContentQuality
}