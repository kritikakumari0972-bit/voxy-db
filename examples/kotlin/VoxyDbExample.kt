// Add OkHttp to your Android app dependencies. Keep WRITE_KEY on your server;
// use a read-only key in APK code.
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

suspend fun loadPosts() {
    val client = OkHttpClient()
    val url = "https://YOUR-VOXYDB-WORKER.workers.dev/v1/projects/YOUR_PROJECT_ID/collections/posts/records?limit=50"
    val request = Request.Builder()
        .url(url)
        .header("Authorization", "Bearer YOUR_READ_ONLY_KEY")
        .get()
        .build()
    client.newCall(request).execute().use { response ->
        check(response.isSuccessful) { "VoxyDB request failed: ${response.code}" }
        println(response.body?.string())
    }
}
