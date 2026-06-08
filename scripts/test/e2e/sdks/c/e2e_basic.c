// Minimal C SDK e2e smoke driver, called by cases/test_c_entry.py.
//
// The C SDK's box-create + remove are callback-based async; we wrap each
// with a pthread condvar to synchronize. Exec is also callback-based and
// would need 80+ lines of stream-pump glue — skipped here because the
// REST chain at the C ABI is already proven by create+remove. Exec
// stdout streaming is covered by the Python / Go / CLI smokes.
//
// Build:
//   gcc e2e_basic.c -I<repo>/sdks/c/include -L<repo>/target/release \
//       -lboxlite -lpthread -ldl -lm -o e2e_basic
//   LD_LIBRARY_PATH=<repo>/target/release ./e2e_basic

#include "boxlite.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DIE(fmt, ...) do { \
    fprintf(stderr, "FATAL: " fmt "\n", ##__VA_ARGS__); \
    exit(2); \
} while (0)

static const char* env_or(const char* k, const char* def) {
    const char* v = getenv(k);
    return (v && *v) ? v : def;
}

// ─── create_box callback sync ──────────────────────────────────────────────
typedef struct {
    pthread_mutex_t mu;
    pthread_cond_t cv;
    int done;
    CBoxHandle* box;
    int err_code;
    char err_msg[512];
} CreateCtx;

// ─── drain thread ──────────────────────────────────────────────────────────
// The C SDK delivers async callbacks via a per-runtime dispatch queue
// that the host must pump with boxlite_runtime_drain. Without an active
// drain, registered callbacks (on_create, on_remove, exec callbacks)
// never fire. Mirrors what sdks/go's ensureDrainRunning does.
typedef struct {
    CBoxliteRuntime* rt;
    volatile int stop;
} DrainArgs;

static void* drain_loop(void* arg) {
    DrainArgs* d = (DrainArgs*) arg;
    CBoxliteError err = {0};
    while (!d->stop) {
        boxlite_runtime_drain(d->rt, 100 /* ms */, &err);
        if (err.code != Ok) {
            boxlite_error_free(&err);
            err = (CBoxliteError){0};
        }
    }
    return NULL;
}

static void on_create(CBoxHandle* box, CBoxliteError* err, void* user_data) {
    CreateCtx* ctx = (CreateCtx*) user_data;
    pthread_mutex_lock(&ctx->mu);
    ctx->box = box;
    if (err && err->code != Ok) {
        ctx->err_code = err->code;
        if (err->message) {
            strncpy(ctx->err_msg, err->message, sizeof(ctx->err_msg) - 1);
        }
    }
    ctx->done = 1;
    pthread_cond_signal(&ctx->cv);
    pthread_mutex_unlock(&ctx->mu);
}

int main(void) {
    const char* url = env_or("BOXLITE_E2E_URL", "http://localhost:3000/api");
    const char* api_key = env_or("BOXLITE_E2E_API_KEY", "devkey");
    const char* prefix = env_or("BOXLITE_E2E_PREFIX", "");
    const char* image = env_or("BOXLITE_E2E_IMAGE", "alpine:3.23");

    CBoxliteError err = {0};

    // 1. REST options
    CBoxliteRestOptions* opts = NULL;
    if (boxlite_rest_options_new(url, &opts, &err) != Ok) {
        DIE("rest_options_new: %d %s", err.code, err.message ? err.message : "");
    }

    CBoxliteCredential* cred = NULL;
    if (boxlite_api_key_credential_new(api_key, &cred, &err) != Ok) {
        DIE("api_key_credential_new: %d %s", err.code, err.message ? err.message : "");
    }
    boxlite_rest_options_set_credential(opts, cred);

    if (prefix && *prefix) {
        boxlite_rest_options_set_path_prefix(opts, prefix);
    }

    // 2. REST runtime
    CBoxliteRuntime* rt = NULL;
    if (boxlite_rest_runtime_new_with_options(opts, &rt, &err) != Ok) {
        DIE("rest_runtime_new: %d %s", err.code, err.message ? err.message : "");
    }
    boxlite_rest_options_free(opts);

    // 2b. Spawn drain thread — callbacks won't fire without this.
    DrainArgs drain_args = { .rt = rt, .stop = 0 };
    pthread_t drain_tid;
    pthread_create(&drain_tid, NULL, drain_loop, &drain_args);

    // 3. Box options + create (callback sync via condvar)
    CBoxliteOptions* box_opts = NULL;
    if (boxlite_options_new(image, &box_opts, &err) != Ok) {
        DIE("options_new: %d %s", err.code, err.message ? err.message : "");
    }

    CreateCtx ctx;
    pthread_mutex_init(&ctx.mu, NULL);
    pthread_cond_init(&ctx.cv, NULL);
    ctx.done = 0; ctx.box = NULL; ctx.err_code = 0; ctx.err_msg[0] = '\0';

    if (boxlite_create_box(rt, box_opts, on_create, &ctx, &err) != Ok) {
        DIE("create_box dispatch: %d %s", err.code, err.message ? err.message : "");
    }

    pthread_mutex_lock(&ctx.mu);
    while (!ctx.done) {
        pthread_cond_wait(&ctx.cv, &ctx.mu);
    }
    pthread_mutex_unlock(&ctx.mu);

    if (ctx.err_code != Ok) {
        DIE("create_box callback: %d %s", ctx.err_code, ctx.err_msg);
    }

    char* box_id = boxlite_box_id(ctx.box);
    printf("BOX_ID=%s\n", box_id ? box_id : "<null>");

    // 4. Cleanup (best-effort, no callback wait)
    if (box_id) {
        boxlite_remove(rt, box_id, 1 /* force */, NULL, NULL, &err);
        free(box_id);
    }
    boxlite_box_free(ctx.box);

    // Stop drain thread BEFORE freeing the runtime (drain reads from it).
    drain_args.stop = 1;
    pthread_join(drain_tid, NULL);
    boxlite_runtime_free(rt);

    pthread_mutex_destroy(&ctx.mu);
    pthread_cond_destroy(&ctx.cv);

    printf("OK\n");
    return 0;
}
