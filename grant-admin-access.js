require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')

// Supabase setup with service role key (needed for admin functions)
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function grantAdminAccess(email) {
  try {
    console.log(`Granting admin access to: ${email}`)

    // Call the grant_admin_access function
    const { data, error } = await supabase.rpc('grant_admin_access', {
      target_email: email
    })

    if (error) {
      throw error
    }

    if (data === true) {
      console.log(`✅ Successfully granted admin access to ${email}`)
      console.log('The user now has:')
      console.log('- Unlimited monthly archive limit (999999)')
      console.log('- Admin status: true')
      console.log('- Subscription status: admin')
    } else {
      console.log(`❌ Failed to grant access. User with email ${email} may not exist.`)
    }

  } catch (error) {
    console.error('Error:', error.message)
  }
}

// Get email from command line argument or use default
const email = process.argv[2] || 'rcglb627@gmail.com'
grantAdminAccess(email)