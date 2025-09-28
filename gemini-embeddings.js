const { GoogleGenerativeAI } = require('@google/generative-ai')
const crypto = require('crypto')

// Initialize Gemini API (you'll need to add GEMINI_API_KEY to your .env)
const genAI = process.env.GEMINI_API_KEY ?
  new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null

/**
 * Generate a hash for content to detect duplicates
 */
function hashContent(url, content) {
  return crypto
    .createHash('sha256')
    .update(`${url}:${content}`)
    .digest('hex')
}

/**
 * Generate embeddings for text using Gemini
 */
async function generateEmbedding(text) {
  if (!genAI) {
    console.warn('Gemini API key not configured, skipping embeddings')
    return null
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'embedding-001' })

    const result = await model.embedContent(text.slice(0, 10000)) // Gemini has higher limits
    const embedding = result.embedding

    return embedding.values // Returns 768-dimensional vector
  } catch (error) {
    console.error('Error generating Gemini embedding:', error)
    return null
  }
}

/**
 * Chunk text into smaller pieces for embedding
 */
function chunkText(text, chunkSize = 1500, overlap = 300) {
  const chunks = []
  let position = 0

  while (position < text.length) {
    let endPosition = Math.min(position + chunkSize, text.length)

    // Try to break at sentence or paragraph boundary
    if (endPosition < text.length) {
      // Look for paragraph break first
      const lastDoubleNewline = text.lastIndexOf('\n\n', endPosition)
      const lastPeriod = text.lastIndexOf('. ', endPosition)
      const lastNewline = text.lastIndexOf('\n', endPosition)

      // Choose the best break point
      let breakPoint = Math.max(lastDoubleNewline, lastPeriod, lastNewline)

      if (breakPoint > position + chunkSize/2) {
        endPosition = breakPoint + 1
      }
    }

    const chunkContent = text.slice(position, endPosition).trim()
    if (chunkContent) {
      chunks.push({
        content: chunkContent,
        index: chunks.length
      })
    }

    position = endPosition - overlap
    if (position <= chunks.length * overlap) {
      position = Math.max(endPosition, position + 1)
    }
  }

  return chunks
}

/**
 * Process an archive with shared embeddings system
 */
async function processArchiveWithSharedEmbeddings(archive, supabase) {
  if (!genAI) {
    console.log('Embeddings disabled - Gemini API key not configured')
    return
  }

  try {
    // Combine title, description, and text for chunking
    const fullText = `${archive.title || ''}\n\n${archive.description || ''}\n\n${archive.archived_text || ''}`

    // Create chunks
    const chunks = chunkText(fullText)

    console.log(`Processing ${chunks.length} chunks for archive ${archive.id} (${archive.url})`)

    const contentIds = []

    // Process each chunk
    for (const chunk of chunks) {
      // Generate hash for this content
      const contentHash = hashContent(archive.url, chunk.content)

      // Check if this content already exists
      const { data: existingContent } = await supabase
        .from('content_embeddings')
        .select('id')
        .eq('content_hash', contentHash)
        .eq('chunk_index', chunk.index)
        .single()

      let contentId

      if (existingContent) {
        // Content already embedded, just link to user
        contentId = existingContent.id
        console.log(`Reusing existing embedding for chunk ${chunk.index}`)
      } else {
        // Generate new embedding
        const embedding = await generateEmbedding(chunk.content)

        if (embedding) {
          // Store in content_embeddings table
          const { data: newContent, error } = await supabase
            .rpc('get_or_create_content', {
              p_content_hash: contentHash,
              p_url: archive.url,
              p_title: archive.title,
              p_chunk_index: chunk.index,
              p_content: chunk.content,
              p_embedding: JSON.stringify(embedding)
            })

          if (error) {
            console.error('Error storing content embedding:', error)
            continue
          }

          contentId = newContent
          console.log(`Created new embedding for chunk ${chunk.index}`)
        }
      }

      if (contentId) {
        contentIds.push(contentId)

        // Link content to user
        const { error: linkError } = await supabase
          .from('user_content')
          .upsert({
            user_id: archive.user_id,
            content_id: contentId,
            archive_id: archive.id,
            tags: archive.tags || []
          }, {
            onConflict: 'user_id,content_id,archive_id'
          })

        if (linkError) {
          console.error('Error linking content to user:', linkError)
        }
      }

      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    console.log(`Successfully processed ${contentIds.length} embeddings for archive ${archive.id}`)
    return contentIds
  } catch (error) {
    console.error('Error processing archive with shared embeddings:', error)
    return []
  }
}

/**
 * Search archives using shared semantic search
 */
async function searchWithSharedEmbeddings(query, userId, supabase) {
  if (!genAI) {
    console.log('Semantic search disabled - Gemini API key not configured')
    return null
  }

  try {
    // Generate embedding for search query
    const queryEmbedding = await generateEmbedding(query)

    if (!queryEmbedding) {
      return null
    }

    // Perform semantic search using shared embeddings
    const { data, error } = await supabase
      .rpc('search_shared_embeddings', {
        query_embedding: JSON.stringify(queryEmbedding),
        match_threshold: 0.65, // Slightly lower threshold for Gemini
        match_count: 30,
        p_user_id: userId
      })

    if (error) {
      console.error('Shared semantic search error:', error)
      return null
    }

    return data
  } catch (error) {
    console.error('Error in shared semantic search:', error)
    return null
  }
}

/**
 * Perform hybrid search with shared embeddings
 */
async function hybridSearchWithSharedEmbeddings(query, userId, supabase) {
  try {
    let queryEmbedding = null

    // Generate embedding if Gemini is configured
    if (genAI) {
      queryEmbedding = await generateEmbedding(query)
    }

    // Perform hybrid search
    const { data, error } = await supabase
      .rpc('search_archives_shared', {
        search_query: query,
        query_embedding: queryEmbedding ? JSON.stringify(queryEmbedding) : null,
        match_count: 30,
        p_user_id: userId
      })

    if (error) {
      console.error('Shared hybrid search error:', error)

      // Fallback to simple text search
      const { data: fallbackData } = await supabase
        .from('archives')
        .select('*')
        .eq('user_id', userId)
        .or(`title.ilike.%${query}%,description.ilike.%${query}%,archived_text.ilike.%${query}%`)
        .limit(30)

      return fallbackData || []
    }

    return data
  } catch (error) {
    console.error('Error in shared hybrid search:', error)
    return []
  }
}

/**
 * Batch process multiple URLs for embeddings
 */
async function batchProcessEmbeddings(archives, supabase) {
  const results = []

  for (const archive of archives) {
    const contentIds = await processArchiveWithSharedEmbeddings(archive, supabase)
    results.push({
      archiveId: archive.id,
      contentIds: contentIds,
      success: contentIds.length > 0
    })
  }

  return results
}

module.exports = {
  generateEmbedding,
  chunkText,
  hashContent,
  processArchiveWithSharedEmbeddings,
  searchWithSharedEmbeddings,
  hybridSearchWithSharedEmbeddings,
  batchProcessEmbeddings
}