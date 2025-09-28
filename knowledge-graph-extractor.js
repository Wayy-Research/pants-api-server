const { GoogleGenerativeAI } = require('@google/generative-ai')
const { createClient } = require('@supabase/supabase-js')

// Initialize Gemini AI
const genAI = process.env.GEMINI_API_KEY ?
  new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null

// Initialize Supabase
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

/**
 * Extract entities and relationships from article content using Gemini
 */
async function extractEntitiesAndRelationships(articleContent, articleTitle, articleUrl) {
  if (!genAI) {
    console.warn('Gemini API key not configured for entity extraction')
    return { entities: [], relationships: [] }
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

    const prompt = `You are an expert knowledge graph extractor. Analyze the following article and extract entities and relationships to build a knowledge graph.

ARTICLE TITLE: ${articleTitle}
ARTICLE URL: ${articleUrl}

ARTICLE CONTENT:
${articleContent}

Extract entities and relationships following these guidelines:

ENTITIES:
1. Extract only significant entities (ignore pronouns, articles, common words)
2. Classify each entity into one of these types: person, organization, concept, topic, location, event, technology
3. Provide a brief description for each entity
4. Assign a confidence score from 0.1 to 1.0 based on how clearly the entity is mentioned

RELATIONSHIPS:
1. Extract meaningful relationships between entities
2. Use descriptive relationship types like: "works_at", "located_in", "founded", "participated_in", "mentioned_with", "leads", "owns", "created", "collaborated_with"
3. Assign strength scores from 0.1 to 1.0 based on how strong the relationship is in the text

Return your response as a JSON object with this exact structure:
{
  "entities": [
    {
      "name": "Entity Name",
      "type": "person|organization|concept|topic|location|event|technology",
      "description": "Brief description",
      "confidence_score": 0.8
    }
  ],
  "relationships": [
    {
      "from_entity": "Entity 1 Name",
      "to_entity": "Entity 2 Name",
      "relationship_type": "works_at",
      "strength": 0.9
    }
  ]
}

Focus on extracting 5-20 entities and 3-15 relationships. Only include entities that are clearly mentioned and relationships that are explicitly stated or strongly implied.`

    const result = await model.generateContent(prompt)
    const response = await result.response
    let extractedData = response.text()

    // Clean up the response to get valid JSON
    extractedData = extractedData
      .replace(/```json\n?/g, '')
      .replace(/```\n?$/g, '')
      .trim()

    try {
      const parsed = JSON.parse(extractedData)

      // Validate the structure
      if (!parsed.entities || !parsed.relationships) {
        throw new Error('Invalid response structure')
      }

      console.log(`Extracted ${parsed.entities.length} entities and ${parsed.relationships.length} relationships`)
      return parsed

    } catch (parseError) {
      console.error('Failed to parse entity extraction response:', parseError)
      console.log('Raw response:', extractedData)
      return { entities: [], relationships: [] }
    }

  } catch (error) {
    console.error('Entity extraction error:', error)
    return { entities: [], relationships: [] }
  }
}

/**
 * Save entities to the database
 */
async function saveEntities(entities, userId) {
  const savedEntities = []

  for (const entity of entities) {
    try {
      // Check if entity already exists for this user
      const { data: existingEntity } = await supabase
        .from('entities')
        .select('id')
        .eq('user_id', userId)
        .eq('name', entity.name)
        .eq('type', entity.type)
        .single()

      if (existingEntity) {
        savedEntities.push(existingEntity)
        continue
      }

      // Insert new entity
      const { data: newEntity, error } = await supabase
        .from('entities')
        .insert({
          user_id: userId,
          name: entity.name,
          type: entity.type,
          description: entity.description,
          confidence_score: entity.confidence_score || 1.0
        })
        .select('id')
        .single()

      if (error) {
        console.error('Error saving entity:', error)
        continue
      }

      savedEntities.push(newEntity)
      console.log(`Saved entity: ${entity.name} (${entity.type})`)

    } catch (error) {
      console.error(`Error processing entity ${entity.name}:`, error)
    }
  }

  return savedEntities
}

/**
 * Save relationships to the database
 */
async function saveRelationships(relationships, entitiesMap, userId) {
  const savedRelationships = []

  for (const relationship of relationships) {
    try {
      // Find entity IDs
      const fromEntityId = entitiesMap[relationship.from_entity]
      const toEntityId = entitiesMap[relationship.to_entity]

      if (!fromEntityId || !toEntityId) {
        console.warn(`Skipping relationship - entities not found: ${relationship.from_entity} -> ${relationship.to_entity}`)
        continue
      }

      // Check if relationship already exists
      const { data: existingRelationship } = await supabase
        .from('relationships')
        .select('id')
        .eq('user_id', userId)
        .eq('from_entity_id', fromEntityId)
        .eq('to_entity_id', toEntityId)
        .eq('relationship_type', relationship.relationship_type)
        .single()

      if (existingRelationship) {
        savedRelationships.push(existingRelationship)
        continue
      }

      // Insert new relationship
      const { data: newRelationship, error } = await supabase
        .from('relationships')
        .insert({
          user_id: userId,
          from_entity_id: fromEntityId,
          to_entity_id: toEntityId,
          relationship_type: relationship.relationship_type,
          strength: relationship.strength || 1.0
        })
        .select('id')
        .single()

      if (error) {
        console.error('Error saving relationship:', error)
        continue
      }

      savedRelationships.push(newRelationship)
      console.log(`Saved relationship: ${relationship.from_entity} ${relationship.relationship_type} ${relationship.to_entity}`)

    } catch (error) {
      console.error(`Error processing relationship:`, error)
    }
  }

  return savedRelationships
}

/**
 * Link entities to an article
 */
async function linkEntitiesToArticle(articleId, entityIds, userId, extractedEntities) {
  for (let i = 0; i < entityIds.length; i++) {
    const entityId = entityIds[i]
    const entity = extractedEntities[i]

    try {
      // Check if link already exists
      const { data: existingLink } = await supabase
        .from('article_entities')
        .select('id')
        .eq('user_id', userId)
        .eq('article_id', articleId)
        .eq('entity_id', entityId)
        .single()

      if (existingLink) {
        continue
      }

      // Insert new link
      await supabase
        .from('article_entities')
        .insert({
          user_id: userId,
          article_id: articleId,
          entity_id: entityId,
          relevance_score: entity.confidence_score || 1.0,
          context: `Mentioned in article: ${entity.name}`
        })

      console.log(`Linked entity ${entity.name} to article`)

    } catch (error) {
      console.error(`Error linking entity to article:`, error)
    }
  }
}

/**
 * Generate article summary using Gemini
 */
async function generateArticleSummary(articleContent, articleTitle) {
  if (!genAI) {
    console.warn('Gemini API key not configured for summary generation')
    return null
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

    const prompt = `Write a concise 2-3 sentence summary of this article. Focus on the main points and key information.

TITLE: ${articleTitle}

CONTENT:
${articleContent}

Summary:`

    const result = await model.generateContent(prompt)
    const response = await result.response
    const summary = response.text().trim()

    console.log(`Generated summary: ${summary.substring(0, 100)}...`)
    return summary

  } catch (error) {
    console.error('Summary generation error:', error)
    return null
  }
}

/**
 * Save article summary to database
 */
async function saveArticleSummary(articleId, summary, userId) {
  if (!summary) return null

  try {
    const { data, error } = await supabase
      .from('article_summaries')
      .insert({
        user_id: userId,
        article_id: articleId,
        summary: summary,
        summary_type: 'ai_generated',
        confidence_score: 0.9
      })
      .select('id')
      .single()

    if (error) {
      console.error('Error saving summary:', error)
      return null
    }

    console.log('Saved article summary')
    return data

  } catch (error) {
    console.error('Error saving article summary:', error)
    return null
  }
}

/**
 * Process an article and extract knowledge graph data
 */
async function processArticleForKnowledgeGraph(articleId, userId) {
  try {
    console.log(`Processing article ${articleId} for knowledge graph...`)

    // Get article content
    const { data: article, error } = await supabase
      .from('archives')
      .select('title, archived_text, archived_markdown, url')
      .eq('id', articleId)
      .eq('user_id', userId)
      .single()

    if (error || !article) {
      console.error('Article not found:', error)
      return false
    }

    // Use markdown content if available, otherwise fall back to text
    const content = article.archived_markdown || article.archived_text || ''

    if (content.length < 100) {
      console.log('Article content too short for processing')
      return false
    }

    // Extract entities and relationships
    const extractedData = await extractEntitiesAndRelationships(
      content,
      article.title,
      article.url
    )

    if (extractedData.entities.length === 0) {
      console.log('No entities extracted from article')
      return false
    }

    // Save entities and get their IDs
    const savedEntities = await saveEntities(extractedData.entities, userId)

    // Create entity name to ID mapping
    const entitiesMap = {}
    savedEntities.forEach((entity, index) => {
      const entityName = extractedData.entities[index].name
      entitiesMap[entityName] = entity.id
    })

    // Save relationships
    await saveRelationships(extractedData.relationships, entitiesMap, userId)

    // Link entities to article
    const entityIds = savedEntities.map(e => e.id)
    await linkEntitiesToArticle(articleId, entityIds, userId, extractedData.entities)

    // Generate and save summary
    const summary = await generateArticleSummary(content, article.title)
    if (summary) {
      await saveArticleSummary(articleId, summary, userId)
    }

    console.log(`✅ Knowledge graph processing complete for article ${articleId}`)
    return true

  } catch (error) {
    console.error('Error processing article for knowledge graph:', error)
    return false
  }
}

/**
 * Batch process multiple articles for knowledge graph extraction
 */
async function batchProcessArticles(articleIds, userId) {
  const results = []

  for (const articleId of articleIds) {
    try {
      const success = await processArticleForKnowledgeGraph(articleId, userId)
      results.push({ articleId, success })

      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000))

    } catch (error) {
      console.error(`Error processing article ${articleId}:`, error)
      results.push({ articleId, success: false, error: error.message })
    }
  }

  return results
}

module.exports = {
  extractEntitiesAndRelationships,
  processArticleForKnowledgeGraph,
  batchProcessArticles,
  generateArticleSummary
}