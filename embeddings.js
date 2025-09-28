const OpenAI = require('openai')

// Initialize OpenAI client (you'll need to add OPENAI_API_KEY to your .env)
const openai = process.env.OPENAI_API_KEY ? new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
}) : null

/**
 * Generate embeddings for text using OpenAI
 */
async function generateEmbedding(text) {
  if (!openai) {
    console.warn('OpenAI API key not configured, skipping embeddings')
    return null
  }

  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: text.slice(0, 8000), // Limit text length
    })

    return response.data[0].embedding
  } catch (error) {
    console.error('Error generating embedding:', error)
    return null
  }
}

/**
 * Chunk text into smaller pieces for embedding
 */
function chunkText(text, chunkSize = 1000, overlap = 200) {
  const chunks = []
  let position = 0

  while (position < text.length) {
    let endPosition = Math.min(position + chunkSize, text.length)

    // Try to break at sentence boundary
    if (endPosition < text.length) {
      const lastPeriod = text.lastIndexOf('.', endPosition)
      const lastNewline = text.lastIndexOf('\n', endPosition)
      const breakPoint = Math.max(lastPeriod, lastNewline)

      if (breakPoint > position + chunkSize/2) {
        endPosition = breakPoint + 1
      }
    }

    chunks.push({
      content: text.slice(position, endPosition).trim(),
      index: chunks.length
    })

    position = endPosition - overlap
    if (position <= chunks.length * overlap) {
      position = Math.max(endPosition, position + 1)
    }
  }

  return chunks
}

/**
 * Process an archive to generate chunks and embeddings
 */
async function processArchiveForEmbeddings(archive, supabase) {
  if (!openai) {
    console.log('Embeddings disabled - OpenAI API key not configured')
    return
  }

  try {
    // Combine title, description, and text for chunking
    const fullText = `${archive.title || ''}\n\n${archive.description || ''}\n\n${archive.archived_text || ''}`

    // Create chunks
    const chunks = chunkText(fullText)

    console.log(`Processing ${chunks.length} chunks for archive ${archive.id}`)

    // Process each chunk
    for (const chunk of chunks) {
      // Generate embedding
      const embedding = await generateEmbedding(chunk.content)

      if (embedding) {
        // Store chunk with embedding
        const { error } = await supabase
          .from('archive_chunks')
          .upsert({
            archive_id: archive.id,
            user_id: archive.user_id,
            chunk_index: chunk.index,
            content: chunk.content,
            embedding: JSON.stringify(embedding), // Supabase expects JSON format for vector
            metadata: {
              title: archive.title,
              url: archive.url
            }
          }, {
            onConflict: 'archive_id,chunk_index'
          })

        if (error) {
          console.error('Error storing chunk:', error)
        }
      }

      // Add delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    console.log(`Successfully processed embeddings for archive ${archive.id}`)
  } catch (error) {
    console.error('Error processing archive for embeddings:', error)
  }
}

/**
 * Search archives using semantic search
 */
async function searchArchivesSemantic(query, userId, supabase) {
  if (!openai) {
    console.log('Semantic search disabled - OpenAI API key not configured')
    return null
  }

  try {
    // Generate embedding for search query
    const queryEmbedding = await generateEmbedding(query)

    if (!queryEmbedding) {
      return null
    }

    // Perform semantic search using Supabase function
    const { data, error } = await supabase
      .rpc('search_archives_semantic', {
        query_embedding: JSON.stringify(queryEmbedding),
        match_threshold: 0.7,
        match_count: 20,
        p_user_id: userId
      })

    if (error) {
      console.error('Semantic search error:', error)
      return null
    }

    return data
  } catch (error) {
    console.error('Error in semantic search:', error)
    return null
  }
}

/**
 * Perform hybrid search (text + semantic)
 */
async function searchArchivesHybrid(query, userId, supabase) {
  try {
    let queryEmbedding = null

    // Generate embedding if OpenAI is configured
    if (openai) {
      queryEmbedding = await generateEmbedding(query)
    }

    // Perform hybrid search
    const { data, error } = await supabase
      .rpc('search_archives_hybrid', {
        search_query: query,
        query_embedding: queryEmbedding ? JSON.stringify(queryEmbedding) : null,
        match_count: 20,
        p_user_id: userId
      })

    if (error) {
      console.error('Hybrid search error:', error)

      // Fallback to simple text search
      const { data: fallbackData } = await supabase
        .from('archives')
        .select('*')
        .eq('user_id', userId)
        .or(`title.ilike.%${query}%,description.ilike.%${query}%,archived_text.ilike.%${query}%`)
        .limit(20)

      return fallbackData || []
    }

    return data
  } catch (error) {
    console.error('Error in hybrid search:', error)
    return []
  }
}

module.exports = {
  generateEmbedding,
  chunkText,
  processArchiveForEmbeddings,
  searchArchivesSemantic,
  searchArchivesHybrid
}