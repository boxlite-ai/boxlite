// C SDK e2e: exec with stdout capture via callback.
// Called by cases/test_c_coverage.py.
//
// Reuses the drain thread + condvar pattern from e2e_basic.c.
// After create, dispatches boxlite_box_exec, registers on_stdout
// and on_exit callbacks, waits for completion via condvar.

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

// ─── drain thread ──────────────────────────────────────────────────────────
typedef struct {
    CBoxliteRuntime* rt;
    volatile int stop;
} DrainArgs;

static void* drain_loop(void* arg) {
    DrainArgs* d = (DrainArgs*) arg;
    CBoxliteError err = {0};
    while (!d->stop) {
        boxlite_runtime_drain(d->rt, 100, &err);
        if (err.code != Ok) {
            boxlite_error_free(&err);
            err = (CBoxliteError){0};
        }
    }
    return NULL;
}

// ─── create callback sync ──────────────────────────────────────────────────
typedef struct {
    pthread_mutex_t mu;
    pthread_cond_t cv;
    int done;
    CBoxHandle* box;
    int err_code;
    char err_msg[512];
} CreateCtx;

static void on_create(CBoxHandle* box, CBoxliteError* err, void* user_data) {
    CreateCtx* ctx = (CreateCtx*) user_data;
    pthread_mutex_lock(&ctx->mu);
    ctx->box = box;
    if (err && err->code != Ok) {
        ctx->err_code = err->code;
        if (err->message) strncpy(ctx->err_msg, err->message, sizeof(ctx->err_msg) - 1);
    }
    ctx->done = 1;
    pthread_cond_signal(&ctx->cv);
    pthread_mutex_unlock(&ctx->mu);
}

// ─── exec stdout + wait sync ───────────────────────────────────────────────
typedef struct {
    pthread_mutex_t mu;
    pthread_cond_t cv;
    int done;
    int exit_code;
    char stdout_buf[4096];
    size_t stdout_len;
    int err_code;
    char err_msg[512];
} ExecCtx;

static void on_stdout(const uint8_t* data, size_t len, void* user_data) {
    ExecCtx* ctx = (ExecCtx*) user_data;
    pthread_mutex_lock(&ctx->mu);
    size_t avail = sizeof(ctx->stdout_buf) - ctx->stdout_len - 1;
    size_t copy = len < avail ? len : avail;
    if (copy > 0) {
        memcpy(ctx->stdout_buf + ctx->stdout_len, data, copy);
        ctx->stdout_len += copy;
        ctx->stdout_buf[ctx->stdout_len] = '\0';
    }
    pthread_mutex_unlock(&ctx->mu);
}

static void on_wait(int exit_code, CBoxliteError* err, void* user_data) {
    ExecCtx* ctx = (ExecCtx*) user_data;
    pthread_mutex_lock(&ctx->mu);
    ctx->exit_code = exit_code;
    if (err && err->code != Ok) {
        ctx->err_code = err->code;
        if (err->message) strncpy(ctx->err_msg, err->message, sizeof(ctx->err_msg) - 1);
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

    // REST options + runtime
    CBoxliteRestOptions* opts = NULL;
    if (boxlite_rest_options_new(url, &opts, &err) != Ok)
        DIE("rest_options_new: %d %s", err.code, err.message ? err.message : "");

    CBoxliteCredential* cred = NULL;
    if (boxlite_api_key_credential_new(api_key, &cred, &err) != Ok)
        DIE("api_key_credential_new: %d %s", err.code, err.message ? err.message : "");
    boxlite_rest_options_set_credential(opts, cred);

    if (prefix && *prefix)
        boxlite_rest_options_set_path_prefix(opts, prefix);

    CBoxliteRuntime* rt = NULL;
    if (boxlite_rest_runtime_new_with_options(opts, &rt, &err) != Ok)
        DIE("rest_runtime_new: %d %s", err.code, err.message ? err.message : "");
    boxlite_rest_options_free(opts);

    DrainArgs drain_args = { .rt = rt, .stop = 0 };
    pthread_t drain_tid;
    pthread_create(&drain_tid, NULL, drain_loop, &drain_args);

    // Create box
    CBoxliteOptions* box_opts = NULL;
    if (boxlite_options_new(image, &box_opts, &err) != Ok)
        DIE("options_new: %d %s", err.code, err.message ? err.message : "");

    CreateCtx cctx;
    pthread_mutex_init(&cctx.mu, NULL);
    pthread_cond_init(&cctx.cv, NULL);
    cctx.done = 0; cctx.box = NULL; cctx.err_code = 0; cctx.err_msg[0] = '\0';

    if (boxlite_create_box(rt, box_opts, on_create, &cctx, &err) != Ok)
        DIE("create_box dispatch: %d %s", err.code, err.message ? err.message : "");

    pthread_mutex_lock(&cctx.mu);
    while (!cctx.done) pthread_cond_wait(&cctx.cv, &cctx.mu);
    pthread_mutex_unlock(&cctx.mu);

    if (cctx.err_code != Ok)
        DIE("create_box callback: %d %s", cctx.err_code, cctx.err_msg);

    char* box_id = boxlite_box_id(cctx.box);
    printf("BOX_ID=%s\n", box_id ? box_id : "<null>");

    // Exec: echo HELLO-FROM-C
    const char* exec_args[] = { "HELLO-FROM-C" };
    BoxliteCommand cmd = {
        .command = "echo",
        .args = exec_args,
        .argc = 1,
        .env_pairs = NULL,
        .env_count = 0,
        .workdir = NULL,
        .user = NULL,
        .timeout_secs = 30.0,
        .tty = 0,
    };

    CExecutionHandle* execution = NULL;
    if (boxlite_box_exec(cctx.box, &cmd, &execution, &err) != Ok)
        DIE("box_exec: %d %s", err.code, err.message ? err.message : "");

    ExecCtx ectx;
    pthread_mutex_init(&ectx.mu, NULL);
    pthread_cond_init(&ectx.cv, NULL);
    ectx.done = 0; ectx.exit_code = -1;
    ectx.stdout_buf[0] = '\0'; ectx.stdout_len = 0;
    ectx.err_code = 0; ectx.err_msg[0] = '\0';

    boxlite_execution_on_stdout(execution, on_stdout, &ectx, &err);
    boxlite_execution_wait(execution, on_wait, &ectx, &err);

    pthread_mutex_lock(&ectx.mu);
    while (!ectx.done) pthread_cond_wait(&ectx.cv, &ectx.mu);
    pthread_mutex_unlock(&ectx.mu);

    if (ectx.err_code != Ok)
        DIE("exec wait: %d %s", ectx.err_code, ectx.err_msg);

    // Trim trailing newline for clean output
    while (ectx.stdout_len > 0 &&
           (ectx.stdout_buf[ectx.stdout_len - 1] == '\n' ||
            ectx.stdout_buf[ectx.stdout_len - 1] == '\r')) {
        ectx.stdout_buf[--ectx.stdout_len] = '\0';
    }

    printf("EXEC_STDOUT=%s\n", ectx.stdout_buf);
    printf("EXIT_CODE=%d\n", ectx.exit_code);

    // Cleanup
    boxlite_execution_free(execution);
    if (box_id) {
        boxlite_remove(rt, box_id, 1, NULL, NULL, &err);
        free(box_id);
    }
    boxlite_box_free(cctx.box);

    drain_args.stop = 1;
    pthread_join(drain_tid, NULL);
    boxlite_runtime_free(rt);

    pthread_mutex_destroy(&cctx.mu);
    pthread_cond_destroy(&cctx.cv);
    pthread_mutex_destroy(&ectx.mu);
    pthread_cond_destroy(&ectx.cv);

    printf("OK\n");
    return 0;
}
