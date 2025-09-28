const Firecrawl = require('@mendable/firecrawl-js').default
const { enhancedContentExtraction } = require('./ai-content-filter')

// Initialize Firecrawl (you'll need to add FIRECRAWL_API_KEY to your .env)
const firecrawl = process.env.FIRECRAWL_API_KEY ?
  new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY }) : null

/**
 * Extract clean content from a URL using Firecrawl
 */
async function extractWithFirecrawl(url) {
  if (!firecrawl) {
    console.warn('Firecrawl API key not configured, falling back to Puppeteer')
    return null
  }

  try {
    console.log(`Extracting content with Firecrawl: ${url}`)

    const scrapeResult = await firecrawl.scrape(url, {
      formats: ['markdown', 'html'],
      waitFor: 3000,
      timeout: 30000,
      onlyMainContent: true, // Extract only main content, remove navigation/ads
      removeBase64Images: true // Don't include base64 images in markdown
    })

    if (!scrapeResult || !scrapeResult.markdown) {
      console.error('Firecrawl extraction failed: No content returned')
      return null
    }

    const data = scrapeResult

    // Extract metadata
    const metadata = {
      title: data.metadata?.title || '',
      description: data.metadata?.description || '',
      keywords: data.metadata?.keywords || '',
      author: data.metadata?.author || '',
      publishedTime: data.metadata?.publishedTime || '',
      ogTitle: data.metadata?.ogTitle || '',
      ogDescription: data.metadata?.ogDescription || '',
      ogImage: data.metadata?.ogImage || '',
      sourceURL: data.metadata?.sourceURL || url,
      statusCode: data.metadata?.statusCode || 200
    }

    // Clean markdown content
    let cleanMarkdown = data.markdown || ''

    // Remove excessive newlines
    cleanMarkdown = cleanMarkdown.replace(/\n{3,}/g, '\n\n')

    // Remove remaining nav/footer content patterns
    cleanMarkdown = cleanMarkdown.replace(/^(Navigation|Menu|Footer|Sidebar)[\s\S]*?$/gm, '')

    // Remove common ad/tracking patterns
    cleanMarkdown = cleanMarkdown.replace(/\[Advertisement\]/g, '')
    cleanMarkdown = cleanMarkdown.replace(/\[Sponsored\]/g, '')

    // Remove signup/newsletter content
    cleanMarkdown = cleanMarkdown.replace(/Loading[\s\S]*?You will now start receiving email updates[\s\S]*?Sign Up/g, '')
    cleanMarkdown = cleanMarkdown.replace(/Email[\s\S]*?Employer[\s\S]*?Job Title[\s\S]*?Sign Up/g, '')
    cleanMarkdown = cleanMarkdown.replace(/reCAPTCHA[\s\S]*?protected by \*\*reCAPTCHA\*\*[\s\S]*?Terms/g, '')

    // Remove skip navigation and similar elements
    cleanMarkdown = cleanMarkdown.replace(/Skip to Main Content\s*/g, '')
    cleanMarkdown = cleanMarkdown.replace(/\* All fields must be completed to subscribe/g, '')
    cleanMarkdown = cleanMarkdown.replace(/Recaptcha requires verification\./g, '')

    // Clean up social sharing elements
    cleanMarkdown = cleanMarkdown.replace(/- \[.*?\]\(.*?\)/g, '')

    // Remove excessive social media and sharing content
    cleanMarkdown = cleanMarkdown.replace(/\\\\\* All fields must be completed to subscribe/g, '')

    // Extract plain text for search
    const plainText = cleanMarkdown
      .replace(/```[\s\S]*?```/g, '') // Remove code blocks
      .replace(/`[^`]*`/g, '') // Remove inline code
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Convert links to text
      .replace(/[#*_`]/g, '') // Remove markdown formatting
      .replace(/\n+/g, ' ') // Replace newlines with spaces
      .trim()

    // Apply AI-powered content filtering
    const baseResult = {
      title: metadata.title || 'Untitled',
      description: metadata.description || metadata.ogDescription || '',
      markdown: cleanMarkdown,
      html: data.html || '',
      text: plainText,
      metadata: metadata,
      wordCount: plainText.split(/\s+/).filter(word => word.length > 0).length,
      readingTime: Math.ceil(plainText.split(/\s+/).length / 200), // Assuming 200 WPM
      extractedAt: new Date().toISOString(),
      extractionMethod: 'firecrawl'
    }

    // Use AI to filter and enhance the content
    const enhancedResult = await enhancedContentExtraction(baseResult, url)

    return enhancedResult

  } catch (error) {
    console.error('Firecrawl extraction error:', error)
    return null
  }
}

/**
 * Enhanced archiving function that tries Firecrawl first, then falls back to Puppeteer
 */
async function archivePageWithFirecrawl(url, fallbackFunction) {
  // Try Firecrawl first
  const firecrawlResult = await extractWithFirecrawl(url)

  if (firecrawlResult) {
    console.log(`✅ Firecrawl extraction successful for ${url}`)
    return firecrawlResult
  }

  // Fallback to Puppeteer if Firecrawl fails
  console.log(`⚠️ Firecrawl failed, falling back to Puppeteer for ${url}`)

  try {
    const puppeteerResult = await fallbackFunction(url)

    // Add extraction method info
    if (puppeteerResult) {
      puppeteerResult.extractionMethod = 'puppeteer-fallback'
      puppeteerResult.metadata = {
        ...puppeteerResult.metadata,
        extractionMethod: 'puppeteer-fallback'
      }
    }

    return puppeteerResult
  } catch (error) {
    console.error('Both Firecrawl and Puppeteer failed:', error)
    throw new Error(`Failed to extract content: ${error.message}`)
  }
}

/**
 * Batch process multiple URLs with Firecrawl
 */
async function batchExtractWithFirecrawl(urls, options = {}) {
  if (!firecrawl) {
    console.warn('Firecrawl not configured for batch processing')
    return []
  }

  const results = []
  const batchSize = options.batchSize || 5
  const delay = options.delay || 1000

  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize)

    console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(urls.length/batchSize)}`)

    const batchPromises = batch.map(url => extractWithFirecrawl(url))
    const batchResults = await Promise.allSettled(batchPromises)

    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        results.push(result.value)
      } else {
        console.error(`Failed to process ${batch[index]}:`, result.reason)
      }
    })

    // Add delay between batches to avoid rate limiting
    if (i + batchSize < urls.length) {
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  return results
}

/**
 * Check if Firecrawl is available and configured
 */
function isFirecrawlAvailable() {
  return !!firecrawl
}

/**
 * Get Firecrawl API usage stats (if available)
 */
async function getFirecrawlUsage() {
  if (!firecrawl) {
    return null
  }

  try {
    // Note: This endpoint may not be available in all Firecrawl plans
    const usage = await firecrawl.getUsage()
    return usage
  } catch (error) {
    console.warn('Could not fetch Firecrawl usage:', error.message)
    return null
  }
}

module.exports = {
  extractWithFirecrawl,
  archivePageWithFirecrawl,
  batchExtractWithFirecrawl,
  isFirecrawlAvailable,
  getFirecrawlUsage
}