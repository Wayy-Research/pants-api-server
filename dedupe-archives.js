const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function findAndRemoveDuplicates() {
  try {
    console.log('🔍 Checking for duplicate archives...')

    // Get user ID first (assuming admin user)
    const { data: users } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('is_admin', true)
      .limit(1)

    if (!users || users.length === 0) {
      console.log('No admin user found')
      return
    }

    const userId = users[0].id
    console.log(`📝 Checking archives for user: ${userId}`)

    // Get all archives with their URLs
    const { data: archives, error } = await supabase
      .from('archives')
      .select('id, url, title, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true }) // Keep the oldest (first imported)

    if (error) throw error

    console.log(`📊 Total archives found: ${archives.length}`)

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

    console.log(`🔍 Found ${duplicateUrls.length} URLs with duplicates`)

    let totalDuplicates = 0
    const idsToDelete = []

    duplicateUrls.forEach(url => {
      const duplicates = urlGroups[url]
      console.log(`📰 "${duplicates[0].title}" has ${duplicates.length} copies`)

      // Keep the first (oldest) and mark the rest for deletion
      for (let i = 1; i < duplicates.length; i++) {
        idsToDelete.push(duplicates[i].id)
        totalDuplicates++
      }
    })

    console.log(`🗑️  Will delete ${totalDuplicates} duplicate archives`)

    if (totalDuplicates === 0) {
      console.log('✅ No duplicates found!')
      return
    }

    // Delete duplicates in batches to avoid query limits
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
      console.log(`🗑️  Deleted ${deleted}/${totalDuplicates} duplicates...`)
    }

    console.log(`✅ Deduplication complete! Deleted ${deleted} duplicate archives`)

    // Get final count
    const { count: finalCount } = await supabase
      .from('archives')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)

    console.log(`📊 Final archive count: ${finalCount}`)

  } catch (error) {
    console.error('❌ Error during deduplication:', error)
  }
}

// Run the deduplication
findAndRemoveDuplicates()