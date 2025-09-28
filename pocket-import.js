const csv = require('csv-parser')
const fs = require('fs')
const { createClient } = require('@supabase/supabase-js')
const { archivePageWithFirecrawl } = require('./firecrawl-extractor')
const { processArchiveWithSharedEmbeddings } = require('./gemini-embeddings')
const { processArticleForKnowledgeGraph } = require('./knowledge-graph-extractor')

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

/**
 * Parse Pocket CSV export and extract URLs
 * Pocket CSV format: "URL","Title","Tags","Time Added","Time Read","Archive"
 */
function parsePocketCSV(csvContent) {
  return new Promise((resolve, reject) => {
    const results = []
    const stream = require('stream')
    const readable = new stream.Readable()
    readable.push(csvContent)
    readable.push(null)

    readable
      .pipe(csv({
        headers: ['url', 'title', 'tags', 'time_added', 'time_read', 'archive'],
        skipEmptyLines: true,
        skipLinesWithError: true
      }))
      .on('data', (data) => {
        // Skip header row and invalid entries
        if (data.url && data.url !== 'URL' && data.url.startsWith('http')) {
          results.push({
            url: data.url.trim(),
            title: data.title ? data.title.trim() : '',
            tags: data.tags ? data.tags.split(',').map(tag => tag.trim()).filter(tag => tag) : [],
            timeAdded: data.time_added ? new Date(data.time_added) : new Date(),
            isArchived: data.archive === '1' || data.archive === 'true'
          })
        }
      })
      .on('end', () => {
        console.log(`Parsed ${results.length} URLs from Pocket CSV`)
        resolve(results)
      })
      .on('error', (error) => {
        console.error('CSV parsing error:', error)
        reject(error)
      })
  })
}

/**
 * Archive a single page with enhanced error handling
 */
async function archiveSinglePage(url, userId, originalTitle = '', tags = []) {
  try {
    console.log(`Archiving: ${url}`)

    // Final safety check: ensure URL doesn't already exist for this user
    const { data: existingArchive, error: checkError } = await supabase
      .from('archives')
      .select('id, url, title')
      .eq('user_id', userId)
      .eq('url', url)
      .single()

    if (existingArchive) {
      console.log(`⏭️  URL already exists in archive: ${existingArchive.title || url}`)
      return {
        success: true,
        skipped: true,
        archive: {
          id: existingArchive.id,
          url: existingArchive.url,
          title: existingArchive.title,
          description: 'Already archived'
        }
      }
    }

    // Fallback function for Puppeteer (simplified)
    const puppeteerFallback = async (url) => {
      const fetch = require('node-fetch')
      const cheerio = require('cheerio')

      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 30000
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const html = await response.text()
        const $ = cheerio.load(html)

        const title = $('title').text() || originalTitle || 'Untitled'
        const description = $('meta[name="description"]').attr('content') ||
                           $('meta[property="og:description"]').attr('content') || ''

        // Basic quality checks for common error patterns
        const titleLower = title.toLowerCase()
        const bodyText = $('body').text().toLowerCase()

        // Reject common error pages
        if (
          titleLower.includes('404') ||
          titleLower.includes('not found') ||
          titleLower.includes('page not found') ||
          titleLower.includes('error') ||
          bodyText.includes('404') ||
          bodyText.includes('page not found') ||
          bodyText.includes('this page doesn\'t exist') ||
          bodyText.includes('access denied') ||
          bodyText.includes('forbidden') ||
          bodyText.includes('unauthorized')
        ) {
          throw new Error('Content appears to be an error page')
        }

        $('script, style').remove()
        const textContent = $('body').text().replace(/\s+/g, ' ').trim()

        // Check for minimal content
        if (textContent.length < 100) {
          throw new Error('Content too short to be valuable')
        }

        const wordCount = textContent.split(/\s+/).filter(word => word.length > 0).length
        if (wordCount < 20) {
          throw new Error('Content has too few meaningful words')
        }

        return {
          title,
          description,
          html,
          text: textContent.substring(0, 50000),
          screenshot: null,
          extractionMethod: 'basic-fetch',
          metadata: {
            extractedAt: new Date().toISOString(),
            fallback: true
          }
        }
      } catch (error) {
        throw new Error(`Fallback extraction failed: ${error.message}`)
      }
    }

    // Archive the page using Firecrawl with basic fetch fallback
    const archivedData = await archivePageWithFirecrawl(url, puppeteerFallback)

    // Use original title if extraction didn't get a good title
    if (!archivedData.title || archivedData.title === 'Untitled') {
      archivedData.title = originalTitle || 'Untitled'
    }

    // Insert into Supabase
    const { data: archive, error: insertError } = await supabase
      .from('archives')
      .insert({
        user_id: userId,
        url: url,
        title: archivedData.title,
        description: archivedData.description,
        archived_html: archivedData.html,
        archived_text: archivedData.text,
        archived_markdown: archivedData.markdown || null,
        extraction_method: archivedData.extractionMethod || 'firecrawl',
        word_count: archivedData.wordCount || 0,
        reading_time: archivedData.readingTime || 0,
        tags: tags || [],
        screenshot_url: null
      })
      .select()
      .single()

    if (insertError) {
      throw insertError
    }

    console.log(`✅ Successfully archived: ${archivedData.title}`)

    // Skip background processing during bulk import to avoid API quotas
    // setTimeout(async () => {
    //   try {
    //     await processArchiveWithSharedEmbeddings(archive, supabase)
    //     await processArticleForKnowledgeGraph(archive.id, userId)
    //   } catch (bgError) {
    //     console.error('Background processing error:', bgError)
    //   }
    // }, 1000)

    return {
      success: true,
      archive: {
        id: archive.id,
        url: archive.url,
        title: archive.title,
        description: archive.description
      }
    }

  } catch (error) {
    console.error(`❌ Failed to archive ${url}:`, error.message)
    return {
      success: false,
      url,
      error: error.message
    }
  }
}

/**
 * Check for duplicate URLs that already exist for the user
 * Uses batching to handle large URL lists that would exceed query limits
 */
async function checkForDuplicates(urls, userId) {
  try {
    const urlList = urls.map(item => item.url)
    const existingUrls = new Set()

    // Process URLs in batches to avoid query size limits
    const batchSize = 100 // Supabase can handle ~100 URLs per query safely

    for (let i = 0; i < urlList.length; i += batchSize) {
      const batch = urlList.slice(i, i + batchSize)

      const { data: existingArchives, error } = await supabase
        .from('archives')
        .select('url')
        .eq('user_id', userId)
        .in('url', batch)

      if (error) {
        console.error('Error checking batch for duplicates:', error)
        // Continue with remaining batches even if one fails
        continue
      }

      // Add found URLs to the set
      existingArchives.forEach(archive => existingUrls.add(archive.url))
    }

    const newUrls = urls.filter(item => !existingUrls.has(item.url))
    const duplicates = urls.filter(item => existingUrls.has(item.url))

    console.log(`Duplicate check: ${duplicates.length} duplicates found, ${newUrls.length} new URLs to import`)

    return { newUrls, duplicates }
  } catch (error) {
    console.error('Error in duplicate check:', error)
    return { newUrls: urls, duplicates: [] }
  }
}

/**
 * Process Pocket import in batches with rate limiting
 */
async function processPocketImport(urls, userId, options = {}) {
  const {
    batchSize = 10,       // Process 10 URLs at a time (increased for speed)
    delayBetweenBatches = 500,   // 0.5 second delay between batches
    delayBetweenRequests = 200,  // 0.2 second delay between individual requests
    maxRetries = 2,
    onProgress = () => {}
  } = options

  const results = {
    total: urls.length,
    successful: 0,
    failed: 0,
    results: []
  }

  // Check for duplicates first
  const { newUrls, duplicates } = await checkForDuplicates(urls, userId)

  console.log(`Starting Pocket import: ${urls.length} total URLs, ${duplicates.length} duplicates found, ${newUrls.length} new URLs to process`)

  // Update results to reflect the total and skipped duplicates
  results.total = urls.length
  results.duplicates = duplicates.length
  results.skipped = duplicates.length

  // Only process new URLs
  const urlsToProcess = newUrls

  for (let i = 0; i < urlsToProcess.length; i += batchSize) {
    const batch = urlsToProcess.slice(i, i + batchSize)
    const batchNumber = Math.floor(i / batchSize) + 1
    const totalBatches = Math.ceil(urlsToProcess.length / batchSize)

    console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} URLs)`)

    // Process batch with concurrent requests for better performance
    const batchPromises = batch.map(async (urlData) => {
      let retries = 0
      let result = null

      while (retries <= maxRetries) {
        try {
          result = await archiveSinglePage(
            urlData.url,
            userId,
            urlData.title,
            urlData.tags
          )
          break
        } catch (error) {
          retries++
          if (retries <= maxRetries) {
            console.log(`Retry ${retries}/${maxRetries} for ${urlData.url}`)
            await new Promise(resolve => setTimeout(resolve, delayBetweenRequests * retries))
          } else {
            result = {
              success: false,
              url: urlData.url,
              error: error.message
            }
          }
        }
      }

      return { urlData, result }
    })

    // Wait for all URLs in the batch to complete
    const batchResults = await Promise.allSettled(batchPromises)

    // Process results
    for (const promiseResult of batchResults) {
      if (promiseResult.status === 'fulfilled') {
        const { urlData, result } = promiseResult.value

        if (result.success) {
          if (result.skipped) {
            results.skipped = (results.skipped || 0) + 1
          } else {
            results.successful++
          }
        } else {
          results.failed++
        }

        results.results.push(result)

        // Call progress callback
        onProgress({
          processed: results.successful + results.failed,
          total: results.total,
          successful: results.successful,
          failed: results.failed,
          currentUrl: urlData.url,
          currentResult: result
        })
      } else {
        // Handle promise rejection
        results.failed++
        results.results.push({
          success: false,
          url: 'unknown',
          error: promiseResult.reason?.message || 'Promise rejected'
        })
      }
    }

    // Delay between batches (except for the last batch)
    if (i + batchSize < urlsToProcess.length && delayBetweenBatches > 0) {
      console.log(`Waiting ${delayBetweenBatches}ms before next batch...`)
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches))
    }
  }

  console.log(`✅ Pocket import complete: ${results.successful} successful, ${results.failed} failed, ${results.skipped || 0} already archived, ${results.duplicates || 0} duplicates skipped`)
  return results
}

/**
 * Validate Pocket CSV content
 */
function validatePocketCSV(csvContent) {
  const lines = csvContent.split('\n')

  if (lines.length < 2) {
    throw new Error('CSV file appears to be empty or has no data rows')
  }

  // Check for Pocket CSV header format
  const header = lines[0].toLowerCase()
  if (!header.includes('url') || !header.includes('title')) {
    throw new Error('CSV file does not appear to be a Pocket export (missing URL and Title columns)')
  }

  // Count valid URLs
  let validUrls = 0
  for (let i = 1; i < Math.min(lines.length, 10); i++) {
    const line = lines[i]
    if (line && line.includes('http')) {
      validUrls++
    }
  }

  if (validUrls === 0) {
    throw new Error('No valid URLs found in CSV file')
  }

  return true
}

/**
 * Get import status for a user
 */
async function getImportStatus(userId) {
  try {
    // Get recent imports from the last 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const { data: recentArchives, error } = await supabase
      .from('archives')
      .select('id, url, title, created_at, extraction_method')
      .eq('user_id', userId)
      .gte('created_at', twentyFourHoursAgo.toISOString())
      .order('created_at', { ascending: false })

    if (error) throw error

    return {
      recentImports: recentArchives.length,
      recentArchives: recentArchives || []
    }
  } catch (error) {
    console.error('Error getting import status:', error)
    return {
      recentImports: 0,
      recentArchives: []
    }
  }
}

module.exports = {
  parsePocketCSV,
  processPocketImport,
  validatePocketCSV,
  getImportStatus,
  archiveSinglePage,
  checkForDuplicates
}