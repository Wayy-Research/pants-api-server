require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')
const fetch = require('node-fetch')
const cheerio = require('cheerio')
// const puppeteer = require('puppeteer') // Removed for deployment
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null
const FirecrawlApp = require('@mendable/firecrawl-js').FirecrawlApp

// Simple Firecrawl availability check
const isFirecrawlAvailable = () => {
  return !!process.env.FIRECRAWL_API_KEY
}
// Import embedding modules for RAG search
const {
  processArchiveWithSharedEmbeddings,
  hybridSearchWithSharedEmbeddings,
  generateEmbedding
} = require('./gemini-embeddings')

// Firecrawl extractor - try to load if available
let archivePageWithFirecrawl
try {
  const firecrawlModule = require('./firecrawl-extractor')
  archivePageWithFirecrawl = firecrawlModule.archivePageWithFirecrawl
} catch (err) {
  console.log('Firecrawl extractor not available, using fallback')
  archivePageWithFirecrawl = async (url, fallbackFn) => fallbackFn(url)
}

// Knowledge graph extractor - try to load if available
let processArticleForKnowledgeGraph = async () => {}
let batchProcessArticles = async () => []
try {
  const kgModule = require('./knowledge-graph-extractor')
  processArticleForKnowledgeGraph = kgModule.processArticleForKnowledgeGraph
  batchProcessArticles = kgModule.batchProcessArticles
} catch (err) {
  console.log('Knowledge graph extractor not available')
}

// Pocket import module - try to load if available
let parsePocketCSV, processPocketImport, validatePocketCSV, getImportStatus, checkForDuplicates
try {
  const pocketModule = require('./pocket-import')
  parsePocketCSV = pocketModule.parsePocketCSV
  processPocketImport = pocketModule.processPocketImport
  validatePocketCSV = pocketModule.validatePocketCSV
  getImportStatus = pocketModule.getImportStatus
  checkForDuplicates = pocketModule.checkForDuplicates
} catch (err) {
  console.log('Pocket import module not available')
  parsePocketCSV = async () => []
  processPocketImport = async () => {}
  validatePocketCSV = () => {}
  getImportStatus = async () => ({ status: 'unavailable' })
  checkForDuplicates = async (urls) => ({ newUrls: urls, duplicates: [] })
}
// Note: Readability requires jsdom, but we'll use a simpler approach for now
// const { Readability } = require('@mozilla/readability')
// const { JSDOM } = require('jsdom')

const app = express()
const PORT = process.env.PORT || 3001

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(supabaseUrl, supabaseServiceKey)

app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() })
})

// Auth verification endpoint for extensions
app.post('/api/auth/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No valid authorization header' })
    }

    const token = authHeader.substring(7)

    // Verify the token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token)

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' })
    }

    res.json({ user: { id: user.id, email: user.email } })
  } catch (error) {
    console.error('Auth verification error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Enhanced archiving function with full HTML, screenshots, and content extraction
async function archivePageCompletely(url) {
  let browser
  try {
    // Launch Puppeteer browser
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    })

    const page = await browser.newPage()

    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    // Navigate to page
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    })

    // Wait for any dynamic content
    await page.waitForTimeout(2000)

    // Extract page data
    const pageData = await page.evaluate(() => {
      return {
        title: document.title,
        html: document.documentElement.outerHTML,
        url: window.location.href,
        meta: {
          description: document.querySelector('meta[name="description"]')?.content ||
                      document.querySelector('meta[property="og:description"]')?.content || '',
          keywords: document.querySelector('meta[name="keywords"]')?.content || '',
          author: document.querySelector('meta[name="author"]')?.content || '',
          publishedTime: document.querySelector('meta[property="article:published_time"]')?.content || '',
        }
      }
    })

    // Take screenshot (PNG doesn't support quality parameter)
    const screenshotBuffer = await page.screenshot({
      fullPage: true,
      type: 'png'
    })

    // Close browser
    await browser.close()

    // Process HTML with Cheerio for additional cleanup
    const $ = cheerio.load(pageData.html)

    // Remove script tags and other unwanted elements
    $('script, style, noscript, iframe[src*="ads"], .advertisement, .ad-banner').remove()

    // Extract clean text content
    const cleanHtml = $.html()

    // Simple content extraction (replace with Readability if needed)
    const article = {
      title: $('title').text() || $('h1').first().text(),
      textContent: $('body').text().replace(/\s+/g, ' ').trim(),
      excerpt: $('meta[name="description"]').attr('content') || $('p').first().text().substring(0, 200)
    }

    // Use screenshot as-is (removed Sharp compression for deployment simplicity)
    const compressedScreenshot = screenshotBuffer

    return {
      title: pageData.title || article?.title || 'Untitled',
      description: pageData.meta.description || article?.excerpt || '',
      html: cleanHtml,
      text: article?.textContent || $('body').text().replace(/\s+/g, ' ').trim(),
      screenshot: compressedScreenshot,
      metadata: {
        ...pageData.meta,
        wordCount: article?.textContent?.split(' ').length || 0,
        readingTime: Math.ceil((article?.textContent?.split(' ').length || 0) / 200),
        extractedAt: new Date().toISOString()
      }
    }
  } catch (error) {
    console.error('Error archiving page:', error)

    // Fallback to basic fetch if Puppeteer fails
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      })
      const html = await response.text()
      const $ = cheerio.load(html)

      const title = $('title').text() || $('h1').first().text() || 'Untitled'
      const description = $('meta[name="description"]').attr('content') ||
                         $('meta[property="og:description"]').attr('content') ||
                         $('p').first().text().substring(0, 200) || ''

      $('script, style').remove()
      const textContent = $('body').text().replace(/\s+/g, ' ').trim()

      return {
        title,
        description,
        html,
        text: textContent.substring(0, 50000), // Limit text content
        screenshot: null,
        metadata: {
          extractedAt: new Date().toISOString(),
          fallback: true
        }
      }
    } catch (fallbackError) {
      throw new Error(`Failed to archive page: ${fallbackError.message}`)
    }
  } finally {
    if (browser) {
      await browser.close()
    }
  }
}

// Upload screenshot to Supabase Storage
async function uploadScreenshot(screenshotBuffer, archiveId) {
  if (!screenshotBuffer) return null

  try {
    const fileName = `screenshots/${archiveId}.png`

    const { data, error } = await supabase.storage
      .from('archives')
      .upload(fileName, screenshotBuffer, {
        contentType: 'image/png',
        cacheControl: '3600'
      })

    if (error) throw error

    const { data: { publicUrl } } = supabase.storage
      .from('archives')
      .getPublicUrl(fileName)

    return publicUrl
  } catch (error) {
    console.error('Error uploading screenshot:', error)
    return null
  }
}

// Archive a new page
app.post('/api/archive', async (req, res) => {
  try {
    const { url, userId, tags = [] } = req.body

    if (!url || !userId) {
      return res.status(400).json({ error: 'URL and userId are required' })
    }

    // Validate URL
    try {
      new URL(url)
    } catch {
      return res.status(400).json({ error: 'Invalid URL' })
    }

    // Check if URL already exists for this user
    const { data: existingArchive, error: duplicateError } = await supabase
      .from('archives')
      .select('id, title, url')
      .eq('user_id', userId)
      .eq('url', url)
      .single()

    if (duplicateError && duplicateError.code !== 'PGRST116') {
      console.error('Duplicate check error:', duplicateError)
      return res.status(500).json({ error: 'Failed to check for duplicates' })
    }

    if (existingArchive) {
      console.log(`URL already archived: ${existingArchive.title || url}`)
      return res.status(409).json({
        error: 'URL already archived',
        archive: {
          id: existingArchive.id,
          url: existingArchive.url,
          title: existingArchive.title
        }
      })
    }

    // Check usage limits
    const { data: usageResult, error: usageError } = await supabase
      .rpc('increment_archive_count', { p_user_id: userId })

    if (usageError) {
      console.error('Usage check error:', usageError)
      return res.status(500).json({ error: 'Failed to check usage limits' })
    }

    if (!usageResult.allowed) {
      return res.status(429).json({
        error: usageResult.message,
        current_count: usageResult.current_count,
        limit: usageResult.limit,
        upgrade_required: true
      })
    }

    console.log(`Archiving: ${url} (${usageResult.current_count}/${usageResult.limit})`)

    // Archive the page using Firecrawl with Puppeteer fallback
    const archivedData = await archivePageWithFirecrawl(url, archivePageCompletely)

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
        tags: Array.isArray(tags) ? tags : [],
        screenshot_url: null // Will update after screenshot upload
      })
      .select()
      .single()

    if (insertError) throw insertError

    // Upload screenshot if available
    if (archivedData.screenshot) {
      const screenshotUrl = await uploadScreenshot(archivedData.screenshot, archive.id)
      if (screenshotUrl) {
        await supabase
          .from('archives')
          .update({ screenshot_url: screenshotUrl })
          .eq('id', archive.id)

        archive.screenshot_url = screenshotUrl
      }
    }

    // Process archive for shared embeddings in the background
    processArchiveWithSharedEmbeddings(archive, supabase).catch(err => {
      console.error('Background embedding processing error:', err)
    })

    // Process article for knowledge graph in the background
    processArticleForKnowledgeGraph(archive.id, userId).catch(err => {
      console.error('Background knowledge graph processing error:', err)
    })

    res.json({
      id: archive.id,
      url: archive.url,
      title: archive.title,
      description: archive.description,
      tags: archive.tags,
      screenshot_url: archive.screenshot_url,
      created_at: archive.created_at,
      metadata: archivedData.metadata
    })

  } catch (error) {
    console.error('Archive error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get user's archives with enhanced search
app.get('/api/archives/:userId', async (req, res) => {
  try {
    const { userId } = req.params
    const { search, tag, limit = 50, offset = 0 } = req.query

    // If search query provided, use hybrid search
    if (search && search.trim()) {
      const results = await hybridSearchWithSharedEmbeddings(search, userId, supabase)

      // Apply tag filtering if needed
      let filteredResults = results
      if (tag) {
        filteredResults = results.filter(r => r.tags && r.tags.includes(tag))
      }

      // Apply pagination
      const paginatedResults = filteredResults.slice(
        parseInt(offset),
        parseInt(offset) + parseInt(limit)
      )

      return res.json(paginatedResults)
    }

    // Regular query without search
    let query = supabase
      .from('archives')
      .select('id, url, title, description, tags, screenshot_url, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1)

    // Add tag filtering
    if (tag) {
      query = query.contains('tags', [tag])
    }

    const { data, error } = await query

    if (error) throw error

    res.json(data || [])
  } catch (error) {
    console.error('Get archives error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get specific archive with full content
app.get('/api/archive/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { data: archive, error } = await supabase
      .from('archives')
      .select('*')
      .eq('id', id)
      .single()

    if (error) throw error
    if (!archive) {
      return res.status(404).json({ error: 'Archive not found' })
    }

    res.json(archive)
  } catch (error) {
    console.error('Get archive error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Serve archived page as HTML
app.get('/api/archive/:id/view', async (req, res) => {
  try {
    const { id } = req.params

    const { data: archive, error } = await supabase
      .from('archives')
      .select('archived_html, title, url')
      .eq('id', id)
      .single()

    if (error) throw error
    if (!archive) {
      return res.status(404).json({ error: 'Archive not found' })
    }

    // Add a banner to indicate this is an archived page
    const archivedHtml = `
      <div style="position: fixed; top: 0; left: 0; right: 0; background: #f59e0b; color: white; padding: 10px; text-align: center; z-index: 10000; font-family: system-ui;">
        📚 Archived Page - Original: <a href="${archive.url}" target="_blank" style="color: white; text-decoration: underline;">${archive.url}</a>
      </div>
      <div style="margin-top: 50px;">
        ${archive.archived_html}
      </div>
    `

    res.setHeader('Content-Type', 'text/html')
    res.send(archivedHtml)
  } catch (error) {
    console.error('View archive error:', error)
    res.status(500).send('Error loading archived page')
  }
})

// Delete archive
app.delete('/api/archive/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { userId } = req.query

    // Delete screenshot from storage first
    try {
      await supabase.storage
        .from('archives')
        .remove([`screenshots/${id}.png`])
    } catch (storageError) {
      console.error('Error deleting screenshot:', storageError)
      // Continue with deletion even if screenshot removal fails
    }

    // Delete from database
    const { error } = await supabase
      .from('archives')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)

    if (error) throw error

    res.json({ success: true })
  } catch (error) {
    console.error('Delete archive error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Update archive tags
app.patch('/api/archive/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { tags, userId } = req.body

    const { data, error } = await supabase
      .from('archives')
      .update({ tags })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) throw error

    res.json(data)
  } catch (error) {
    console.error('Update archive error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Legacy endpoint for browser extension compatibility
app.post('/api/links', async (req, res) => {
  try {
    const { url, tags, userId } = req.body

    // Forward to new archive endpoint
    const response = await fetch(`${req.protocol}://${req.get('host')}/api/archive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url,
        userId,
        tags: tags ? tags.split(',').map(t => t.trim()).filter(t => t) : []
      })
    })

    const data = await response.json()

    if (!response.ok) {
      return res.status(response.status).json(data)
    }

    res.json(data)
  } catch (error) {
    console.error('Legacy links endpoint error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Stripe webhook endpoint (must be before body parsing middleware)
app.post('/api/stripe/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        const subscription = event.data.object
        await handleSubscriptionUpdate(subscription)
        break

      case 'customer.subscription.deleted':
        const canceledSubscription = event.data.object
        await handleSubscriptionCanceled(canceledSubscription)
        break

      case 'invoice.payment_succeeded':
        const invoice = event.data.object
        if (invoice.billing_reason === 'subscription_create') {
          await handleFirstPayment(invoice)
        }
        break

      default:
        console.log(`Unhandled event type ${event.type}`)
    }

    res.json({ received: true })
  } catch (error) {
    console.error('Webhook error:', error)
    res.status(500).json({ error: 'Webhook handler failed' })
  }
})

// Create Stripe checkout session
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    const { userId, email } = req.body

    if (!userId || !email) {
      return res.status(400).json({ error: 'userId and email are required' })
    }

    // Check if customer already exists
    let customer
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single()

    if (userProfile?.stripe_customer_id) {
      customer = await stripe.customers.retrieve(userProfile.stripe_customer_id)
    } else {
      // Create new customer
      customer = await stripe.customers.create({
        email: email,
        metadata: {
          supabase_user_id: userId
        }
      })

      // Update user profile with customer ID
      await supabase
        .from('user_profiles')
        .update({ stripe_customer_id: customer.id })
        .eq('id', userId)
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // You'll create this in Stripe dashboard
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/dashboard?success=true`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard?canceled=true`,
      metadata: {
        user_id: userId
      }
    })

    res.json({ url: session.url })
  } catch (error) {
    console.error('Checkout session error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Create Stripe customer portal session
app.post('/api/stripe/create-portal-session', async (req, res) => {
  try {
    const { userId } = req.body

    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single()

    if (!userProfile?.stripe_customer_id) {
      return res.status(400).json({ error: 'No subscription found' })
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: userProfile.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/dashboard`,
    })

    res.json({ url: portalSession.url })
  } catch (error) {
    console.error('Portal session error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get current user info (for bookmarklet authentication check)
app.get('/api/user', async (req, res) => {
  try {
    // This is a simplified endpoint for the bookmarklet
    // In a real implementation, you'd verify the user's session/token
    const { userId } = req.query

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    // Verify user exists
    const { data: user, error } = await supabase
      .from('user_profiles')
      .select('id, email')
      .eq('id', userId)
      .single()

    if (error || !user) {
      return res.status(401).json({ error: 'User not found' })
    }

    res.json({
      user: {
        id: user.id,
        email: user.email
      }
    })
  } catch (error) {
    console.error('Get user error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get user subscription status
app.get('/api/subscription/:userId', async (req, res) => {
  try {
    const { userId } = req.params

    const { data: userProfile, error } = await supabase
      .from('user_profiles')
      .select(`
        subscription_status,
        monthly_archive_limit,
        is_admin,
        stripe_subscription_id,
        subscription_period_end
      `)
      .eq('id', userId)
      .single()

    if (error) throw error

    // For admins, show total archives. For others, show current month usage
    let currentUsage
    if (userProfile.is_admin) {
      // Get total archive count for admins
      const { count: totalUsage } = await supabase
        .from('archives')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
      currentUsage = totalUsage
    } else {
      // Get current month usage for regular users
      const startOfMonth = new Date()
      startOfMonth.setDate(1)
      startOfMonth.setHours(0, 0, 0, 0)

      const { count: monthlyUsage } = await supabase
        .from('archives')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', startOfMonth.toISOString())
      currentUsage = monthlyUsage
    }

    res.json({
      status: userProfile.subscription_status,
      limit: userProfile.monthly_archive_limit,
      current_usage: currentUsage || 0,
      is_admin: userProfile.is_admin,
      has_subscription: !!userProfile.stripe_subscription_id,
      period_end: userProfile.subscription_period_end
    })
  } catch (error) {
    console.error('Get subscription error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Webhook handlers
async function handleSubscriptionUpdate(subscription) {
  const userId = subscription.metadata?.user_id
  if (!userId) return

  const status = subscription.status
  const isActive = ['active', 'trialing'].includes(status)

  // Determine plan details based on subscription items
  let planDetails = { plan_id: 'free', limit: 10, amount: 0, status: 'free' }

  if (isActive && subscription.items && subscription.items.data.length > 0) {
    const priceId = subscription.items.data[0].price.id
    const amount = subscription.items.data[0].price.unit_amount

    // Determine plan based on price amount
    if (amount === 300) { // $3.00 Premium
      planDetails = { plan_id: 'premium_monthly', limit: 100, amount: 300, status: 'premium' }
    } else if (amount === 900) { // $9.00 Pro
      planDetails = { plan_id: 'pro_monthly', limit: 999999, amount: 900, status: 'pro' }
    } else if (amount === 3) { // Legacy $0.03 for testing
      planDetails = { plan_id: 'premium_monthly', limit: 100, amount: 300, status: 'premium' }
    }
  }

  await supabase
    .from('user_profiles')
    .update({
      stripe_subscription_id: subscription.id,
      subscription_status: isActive ? planDetails.status : status,
      monthly_archive_limit: isActive ? planDetails.limit : 10,
      subscription_period_end: new Date(subscription.current_period_end * 1000).toISOString()
    })
    .eq('id', userId)

  // Update subscription record
  await supabase
    .from('subscriptions')
    .upsert({
      user_id: userId,
      stripe_subscription_id: subscription.id,
      stripe_customer_id: subscription.customer,
      status: subscription.status,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      plan_id: planDetails.plan_id,
      amount: planDetails.amount,
      currency: 'usd'
    }, { onConflict: 'stripe_subscription_id' })
}

async function handleSubscriptionCanceled(subscription) {
  const userId = subscription.metadata?.user_id
  if (!userId) return

  await supabase
    .from('user_profiles')
    .update({
      subscription_status: 'canceled',
      monthly_archive_limit: 10
    })
    .eq('id', userId)

  await supabase
    .from('subscriptions')
    .update({ status: 'canceled' })
    .eq('stripe_subscription_id', subscription.id)
}

async function handleFirstPayment(invoice) {
  // Additional logic for successful first payment if needed
  console.log('First payment successful for subscription:', invoice.subscription)
}

// Helper function to extract relevant snippet around search terms
function extractSnippet(text, query, maxLength = 300) {
  if (!text) return ''

  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)
  const textLower = text.toLowerCase()

  // Find the best position (where most query terms appear nearby)
  let bestPos = 0
  let bestScore = 0

  for (let i = 0; i < text.length - 100; i += 50) {
    const window = textLower.slice(i, i + maxLength)
    const score = queryTerms.reduce((acc, term) => acc + (window.includes(term) ? 1 : 0), 0)
    if (score > bestScore) {
      bestScore = score
      bestPos = i
    }
  }

  // Extract snippet around best position
  let start = Math.max(0, bestPos - 50)
  let end = Math.min(text.length, start + maxLength)

  // Adjust to word boundaries
  if (start > 0) {
    const spacePos = text.indexOf(' ', start)
    if (spacePos !== -1 && spacePos < start + 20) start = spacePos + 1
  }
  if (end < text.length) {
    const spacePos = text.lastIndexOf(' ', end)
    if (spacePos !== -1 && spacePos > end - 20) end = spacePos
  }

  let snippet = text.slice(start, end).trim()
  if (start > 0) snippet = '...' + snippet
  if (end < text.length) snippet = snippet + '...'

  return snippet
}

// Helper to highlight query terms in text
function highlightTerms(text, query) {
  if (!text || !query) return text

  const terms = query.split(/\s+/).filter(t => t.length > 2)
  let highlighted = text

  terms.forEach(term => {
    const regex = new RegExp(`(${term})`, 'gi')
    highlighted = highlighted.replace(regex, '**$1**')
  })

  return highlighted
}

// Enhanced search endpoint with RAG capabilities
app.post('/api/search', async (req, res) => {
  try {
    const { query, userId, mode = 'hybrid', limit = 20 } = req.body

    if (!query || !userId) {
      return res.status(400).json({ error: 'Query and userId are required' })
    }

    console.log(`🔍 Smart search: "${query}" for user ${userId}`)

    // Perform hybrid search (text + semantic if available)
    const results = await hybridSearchWithSharedEmbeddings(query, userId, supabase)

    // Group results by archive and enrich with snippets
    const groupedResults = {}

    for (const result of results) {
      const archiveId = result.archive_id || result.id

      if (!groupedResults[archiveId]) {
        // Fetch full archive data if not already present
        let archiveData = result
        if (!result.archived_text) {
          const { data } = await supabase
            .from('archives')
            .select('id, url, title, description, archived_text, tags, screenshot_url, created_at')
            .eq('id', archiveId)
            .single()
          if (data) archiveData = { ...result, ...data }
        }

        // Extract relevant snippet from the content
        const snippet = extractSnippet(
          archiveData.archived_text || archiveData.description || '',
          query,
          300
        )

        groupedResults[archiveId] = {
          id: archiveId,
          title: archiveData.title || 'Untitled',
          description: archiveData.description || '',
          url: archiveData.url,
          tags: archiveData.tags || [],
          screenshot_url: archiveData.screenshot_url,
          created_at: archiveData.created_at,
          relevance_score: result.relevance_score || result.similarity || 0,
          snippet: highlightTerms(snippet, query),
          matching_chunks: [],
          match_type: result.match_type || (result.similarity ? 'semantic' : 'text')
        }
      }

      // Add matching chunks if available
      if (result.chunk_id || result.content) {
        const chunkContent = result.content || result.chunk_content
        if (chunkContent) {
          groupedResults[archiveId].matching_chunks.push({
            content: highlightTerms(chunkContent.slice(0, 200), query),
            similarity: result.similarity || 0
          })
        }
      }
    }

    // Convert to array, sort by relevance, and limit
    const finalResults = Object.values(groupedResults)
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, parseInt(limit))

    // Calculate search metadata
    const hasSemanticResults = finalResults.some(r => r.match_type === 'semantic')
    const avgRelevance = finalResults.length > 0
      ? finalResults.reduce((acc, r) => acc + r.relevance_score, 0) / finalResults.length
      : 0

    console.log(`✅ Found ${finalResults.length} results (semantic: ${hasSemanticResults})`)

    res.json({
      query: query,
      mode: hasSemanticResults ? 'hybrid' : 'text',
      results: finalResults,
      total_count: finalResults.length,
      metadata: {
        semantic_enabled: !!process.env.GEMINI_API_KEY,
        avg_relevance: Math.round(avgRelevance * 100) / 100,
        search_time_ms: Date.now() - req._startTime || 0
      }
    })
  } catch (error) {
    console.error('Search error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Reprocess embeddings for existing archives (admin endpoint)
app.post('/api/admin/reprocess-embeddings', async (req, res) => {
  try {
    const { userId, adminKey } = req.body

    // Simple admin authentication - you should use a proper auth system
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    // Get all archives for the user
    const { data: archives, error } = await supabase
      .from('archives')
      .select('*')
      .eq('user_id', userId)

    if (error) throw error

    // Process each archive with shared embeddings
    let processed = 0
    for (const archive of archives) {
      await processArchiveWithSharedEmbeddings(archive, supabase)
      processed++
    }

    res.json({
      message: 'Embeddings reprocessed successfully',
      processed_count: processed
    })
  } catch (error) {
    console.error('Reprocess embeddings error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Knowledge Graph API Endpoints

// Get user's knowledge graph entities
app.get('/api/knowledge-graph/entities/:userId', async (req, res) => {
  try {
    const { userId } = req.params
    const { type, limit = 50, offset = 0 } = req.query

    let query = supabase
      .from('entities')
      .select(`
        id,
        name,
        type,
        description,
        confidence_score,
        created_at,
        updated_at
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1)

    if (type) {
      query = query.eq('type', type)
    }

    const { data, error } = await query

    if (error) throw error

    res.json(data || [])
  } catch (error) {
    console.error('Get entities error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get relationships for a specific entity
app.get('/api/knowledge-graph/entity/:entityId/relationships', async (req, res) => {
  try {
    const { entityId } = req.params
    const { userId } = req.query

    const { data, error } = await supabase
      .from('relationships')
      .select(`
        id,
        relationship_type,
        strength,
        created_at,
        from_entity:from_entity_id(id, name, type),
        to_entity:to_entity_id(id, name, type)
      `)
      .eq('user_id', userId)
      .or(`from_entity_id.eq.${entityId},to_entity_id.eq.${entityId}`)
      .order('strength', { ascending: false })

    if (error) throw error

    res.json(data || [])
  } catch (error) {
    console.error('Get entity relationships error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get articles related to an entity
app.get('/api/knowledge-graph/entity/:entityId/articles', async (req, res) => {
  try {
    const { entityId } = req.params
    const { userId } = req.query

    const { data, error } = await supabase
      .from('article_entities')
      .select(`
        relevance_score,
        context,
        archive:article_id(
          id,
          title,
          description,
          url,
          created_at
        )
      `)
      .eq('user_id', userId)
      .eq('entity_id', entityId)
      .order('relevance_score', { ascending: false })

    if (error) throw error

    res.json(data || [])
  } catch (error) {
    console.error('Get entity articles error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get knowledge graph statistics for a user
app.get('/api/knowledge-graph/stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params

    // Get entity counts by type
    const { data: entityStats, error: entityError } = await supabase
      .from('entities')
      .select('type')
      .eq('user_id', userId)

    if (entityError) throw entityError

    const entityCounts = entityStats.reduce((acc, entity) => {
      acc[entity.type] = (acc[entity.type] || 0) + 1
      return acc
    }, {})

    // Get relationship count
    const { count: relationshipCount, error: relationshipError } = await supabase
      .from('relationships')
      .select('id', { count: 'exact' })
      .eq('user_id', userId)

    if (relationshipError) throw relationshipError

    // Get article count with entities
    const { count: articleCount, error: articleError } = await supabase
      .from('article_entities')
      .select('article_id', { count: 'exact' })
      .eq('user_id', userId)

    if (articleError) throw articleError

    res.json({
      total_entities: entityStats.length,
      entity_counts: entityCounts,
      total_relationships: relationshipCount,
      articles_with_entities: articleCount
    })
  } catch (error) {
    console.error('Get knowledge graph stats error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get article summary
app.get('/api/archive/:articleId/summary', async (req, res) => {
  try {
    const { articleId } = req.params
    const { userId } = req.query

    const { data, error } = await supabase
      .from('article_summaries')
      .select('summary, summary_type, confidence_score, created_at')
      .eq('user_id', userId)
      .eq('article_id', articleId)
      .eq('summary_type', 'ai_generated')
      .single()

    if (error && error.code !== 'PGRST116') throw error

    res.json(data || null)
  } catch (error) {
    console.error('Get article summary error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Manually process an article for knowledge graph
app.post('/api/knowledge-graph/process-article', async (req, res) => {
  try {
    const { articleId, userId } = req.body

    if (!articleId || !userId) {
      return res.status(400).json({ error: 'articleId and userId are required' })
    }

    const success = await processArticleForKnowledgeGraph(articleId, userId)

    res.json({
      success,
      message: success ? 'Article processed successfully' : 'Failed to process article'
    })
  } catch (error) {
    console.error('Process article error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Batch process articles for knowledge graph
app.post('/api/knowledge-graph/batch-process', async (req, res) => {
  try {
    const { userId, limit = 10 } = req.body

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    // Get unprocessed articles (articles without entities)
    const { data: articles, error } = await supabase
      .from('archives')
      .select('id')
      .eq('user_id', userId)
      .not('id', 'in', `(
        SELECT DISTINCT article_id
        FROM article_entities
        WHERE user_id = '${userId}'
      )`)
      .limit(limit)

    if (error) throw error

    if (articles.length === 0) {
      return res.json({
        message: 'No unprocessed articles found',
        processed: 0,
        results: []
      })
    }

    const articleIds = articles.map(a => a.id)
    const results = await batchProcessArticles(articleIds, userId)

    res.json({
      message: `Processed ${articleIds.length} articles`,
      processed: articleIds.length,
      results
    })
  } catch (error) {
    console.error('Batch process articles error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Deduplication endpoint (admin only)
app.post('/api/admin/dedupe', async (req, res) => {
  try {
    const { userId } = req.body

    // Verify admin status
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('is_admin')
      .eq('id', userId)
      .single()

    if (!userProfile?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' })
    }

    // Get all archives with their URLs
    const { data: archives, error } = await supabase
      .from('archives')
      .select('id, url, title, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })

    if (error) throw error

    console.log(`Found ${archives.length} total archives`)

    // Group by URL to find duplicates
    const urlGroups = {}
    archives.forEach(archive => {
      if (!urlGroups[archive.url]) {
        urlGroups[archive.url] = []
      }
      urlGroups[archive.url].push(archive)
    })

    // Find URLs with duplicates
    const duplicateUrls = Object.keys(urlGroups).filter(url => urlGroups[url].length > 1)
    const idsToDelete = []

    duplicateUrls.forEach(url => {
      const duplicates = urlGroups[url]
      console.log(`URL ${url} has ${duplicates.length} copies`)
      // Keep the first (oldest) and mark the rest for deletion
      for (let i = 1; i < duplicates.length; i++) {
        idsToDelete.push(duplicates[i].id)
      }
    })

    if (idsToDelete.length === 0) {
      return res.json({
        message: 'No duplicates found',
        totalArchives: archives.length,
        duplicatesRemoved: 0
      })
    }

    console.log(`Will delete ${idsToDelete.length} duplicates`)

    // Delete duplicates in batches
    const batchSize = 100
    let deleted = 0

    for (let i = 0; i < idsToDelete.length; i += batchSize) {
      const batch = idsToDelete.slice(i, i + batchSize)

      const { error: deleteError } = await supabase
        .from('archives')
        .delete()
        .in('id', batch)

      if (deleteError) {
        console.error('Error deleting batch:', deleteError)
        continue
      }

      deleted += batch.length
      console.log(`Deleted ${deleted}/${idsToDelete.length} duplicates`)
    }

    // Get final count
    const { count: finalCount } = await supabase
      .from('archives')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)

    console.log(`Final count: ${finalCount}`)

    res.json({
      message: 'Deduplication complete',
      originalCount: archives.length,
      duplicatesRemoved: deleted,
      finalCount: finalCount
    })

  } catch (error) {
    console.error('Deduplication error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Pocket Import API Endpoints

// Validate and preview Pocket CSV
app.post('/api/pocket/validate', async (req, res) => {
  console.log('🔍 Validation request received:', { hasContent: !!req.body.csvContent, userId: req.body.userId })
  try {
    const { csvContent, userId } = req.body

    if (!csvContent) {
      return res.status(400).json({ error: 'CSV content is required' })
    }

    // Validate CSV format
    validatePocketCSV(csvContent)

    // Parse and preview URLs
    const urls = await parsePocketCSV(csvContent)

    let duplicateInfo = { newUrls: urls, duplicates: [] }

    // Check for duplicates if userId is provided
    if (userId) {
      try {
        duplicateInfo = await checkForDuplicates(urls, userId)
      } catch (error) {
        console.error('Duplicate check failed during validation, proceeding without duplicate detection:', error)
        // Proceed without duplicate checking for now
        duplicateInfo = { newUrls: urls, duplicates: [] }
      }
    }

    // Return preview data with duplicate information
    res.json({
      valid: true,
      total_urls: urls.length,
      new_urls: duplicateInfo.newUrls.length,
      duplicate_urls: duplicateInfo.duplicates.length,
      preview: duplicateInfo.newUrls.slice(0, 10), // Show first 10 new URLs
      has_more: duplicateInfo.newUrls.length > 10,
      duplicates_preview: duplicateInfo.duplicates.slice(0, 5).map(d => ({ url: d.url, title: d.title }))
    })
  } catch (error) {
    console.error('Pocket CSV validation error:', error)
    res.status(400).json({
      valid: false,
      error: error.message
    })
  }
})

// Start Pocket import process
app.post('/api/pocket/import', async (req, res) => {
  try {
    const { csvContent, userId, options = {} } = req.body

    if (!csvContent || !userId) {
      return res.status(400).json({ error: 'CSV content and userId are required' })
    }

    // Validate and parse CSV
    validatePocketCSV(csvContent)
    const urls = await parsePocketCSV(csvContent)

    if (urls.length === 0) {
      return res.status(400).json({ error: 'No valid URLs found in CSV' })
    }

    // Check if user has sufficient quota
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('monthly_archive_limit, subscription_status')
      .eq('id', userId)
      .single()

    if (userProfile && urls.length > userProfile.monthly_archive_limit) {
      return res.status(429).json({
        error: 'Import would exceed monthly archive limit',
        limit: userProfile.monthly_archive_limit,
        requested: urls.length,
        upgrade_required: true
      })
    }

    // Start import process (this will run in background)
    const importOptions = {
      batchSize: options.batchSize || 3,
      delayBetweenBatches: options.delayBetweenBatches || 2000,
      delayBetweenRequests: options.delayBetweenRequests || 1000,
      maxRetries: options.maxRetries || 2
    }

    // Return immediate response and process in background
    res.json({
      message: 'Import started successfully',
      total_urls: urls.length,
      estimated_time_minutes: Math.ceil(urls.length * 2 / 60), // Rough estimate
      status: 'started'
    })

    // Process import in background
    processPocketImport(urls, userId, importOptions)
      .then(results => {
        console.log(`✅ Pocket import completed for user ${userId}:`, results)
      })
      .catch(error => {
        console.error(`❌ Pocket import failed for user ${userId}:`, error)
      })

  } catch (error) {
    console.error('Pocket import error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get import status
app.get('/api/pocket/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params
    const status = await getImportStatus(userId)
    res.json(status)
  } catch (error) {
    console.error('Get import status error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.listen(PORT, () => {
  console.log(`Enhanced Pants server running at http://localhost:${PORT}`)
  console.log('Features: Full HTML archiving, screenshots, Supabase integration, Stripe subscriptions')
  console.log('Content Extraction: ' + (isFirecrawlAvailable() ? 'Firecrawl + Cheerio fallback' : 'Cheerio only'))
  console.log('RAG Search: ' + (process.env.GEMINI_API_KEY ? 'Enabled with Gemini embeddings + shared content' : 'Text-only mode'))
  console.log('Knowledge Graph: ' + (process.env.GEMINI_API_KEY ? 'Enabled with entity extraction and AI summaries' : 'Disabled - Gemini API key required'))
  console.log('Pocket Import: Enabled with batch processing and rate limiting')
})