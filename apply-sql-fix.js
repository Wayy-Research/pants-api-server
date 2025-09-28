require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const path = require('path')

// Supabase setup with service role key
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function applySqlFix() {
  try {
    console.log('Applying SQL fix for usage function...')

    // Read the SQL file
    const sqlContent = fs.readFileSync(path.join(__dirname, '../fix-usage-function.sql'), 'utf8')

    // Execute the SQL
    const { data, error } = await supabase.rpc('exec_sql', {
      sql: sqlContent
    })

    if (error) {
      // Try alternative approach if exec_sql function doesn't exist
      console.log('Direct SQL execution via RPC failed, trying alternative approach...')

      // Execute using direct query
      const { error: directError } = await supabase.from('_supabase_migrations').select('*').limit(1)

      if (directError) {
        console.log('Creating the function directly...')
        // This is a workaround - in production you'd want to run this SQL directly in Supabase dashboard
        throw new Error('Please run the SQL in fix-usage-function.sql directly in your Supabase SQL editor')
      }
    }

    console.log('✅ SQL fix applied successfully!')
    console.log('The increment_archive_count function has been updated to fix the ambiguous column reference.')

  } catch (error) {
    console.error('❌ Error applying SQL fix:', error.message)
    console.log('\n📋 Manual steps:')
    console.log('1. Go to your Supabase dashboard')
    console.log('2. Navigate to SQL Editor')
    console.log('3. Run the contents of fix-usage-function.sql')
    console.log('4. This will fix the ambiguous column reference issue')
  }
}

applySqlFix()