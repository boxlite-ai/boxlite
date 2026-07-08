#include "boxlite.h"
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

typedef struct {
    CBoxliteRuntime *runtime;
    CBoxHandle *box;
    CExecutionHandle *exec;
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    int done;
    int failed;
    int exit_code;
} Quickstart;

typedef struct {
    CBoxliteRuntime *runtime;
    volatile int stop;
} DrainLoop;

static int has_error(const CBoxliteError *error) {
    return error && error->code != Ok;
}

static void print_error(const char *op, CBoxliteError *error) {
    fprintf(stderr, "%s failed: %s\n", op, error && error->message ? error->message : "unknown");
    if (error) {
        boxlite_error_free(error);
    }
}

static void require_ok(BoxliteErrorCode code, const char *op, CBoxliteError *error) {
    if (code != Ok) {
        print_error(op, error);
        exit(1);
    }
}

static void *drain_loop(void *user_data) {
    DrainLoop *loop = (DrainLoop *)user_data;
    CBoxliteError error = {0};

    while (!loop->stop) {
        if (boxlite_runtime_drain(loop->runtime, 100, &error) < 0) {
            print_error("drain", &error);
            error = (CBoxliteError){0};
        }
    }
    return NULL;
}

static void prepare_wait(Quickstart *qs) {
    pthread_mutex_lock(&qs->mutex);
    qs->done = 0;
    qs->failed = 0;
    pthread_mutex_unlock(&qs->mutex);
}

static void wait_until_done(Quickstart *qs) {
    pthread_mutex_lock(&qs->mutex);
    while (!qs->done) {
        pthread_cond_wait(&qs->cond, &qs->mutex);
    }
    int failed = qs->failed;
    pthread_mutex_unlock(&qs->mutex);

    if (failed) {
        exit(1);
    }
}

static void on_create(CBoxHandle *box, CBoxliteError *error, void *user_data) {
    Quickstart *qs = (Quickstart *)user_data;
    pthread_mutex_lock(&qs->mutex);
    if (has_error(error)) {
        print_error("create box", error);
        qs->failed = 1;
    } else {
        qs->box = box;
    }
    qs->done = 1;
    pthread_cond_signal(&qs->cond);
    pthread_mutex_unlock(&qs->mutex);
}

static void on_done(CBoxliteError *error, void *user_data) {
    Quickstart *qs = (Quickstart *)user_data;
    pthread_mutex_lock(&qs->mutex);
    if (has_error(error)) {
        print_error("operation", error);
        qs->failed = 1;
    }
    qs->done = 1;
    pthread_cond_signal(&qs->cond);
    pthread_mutex_unlock(&qs->mutex);
}

static void on_wait(int exit_code, CBoxliteError *error, void *user_data) {
    Quickstart *qs = (Quickstart *)user_data;
    pthread_mutex_lock(&qs->mutex);
    if (has_error(error)) {
        print_error("wait", error);
        qs->failed = 1;
    }
    qs->exit_code = exit_code;
    qs->done = 1;
    pthread_cond_signal(&qs->cond);
    pthread_mutex_unlock(&qs->mutex);
}

static void on_stdout(const uint8_t *data, size_t len, void *user_data) {
    (void)user_data;
    fwrite(data, 1, len, stdout);
}

int main(void) {
    const char *api_key = {{API_KEY_C}};
    const char *api_url = getenv("BOXLITE_REST_URL");
    if (!api_key) {
        fprintf(stderr, "Set BOXLITE_API_KEY before running this program\n");
        return 1;
    }
    if (!api_url) {
        api_url = "{{REST_API_URL}}";
    }

    CBoxliteError error = {0};
    CBoxliteCredential *credential = NULL;
    CBoxliteRestOptions *rest = NULL;
    CBoxliteOptions *box_options = NULL;
    Quickstart qs = {0};
    pthread_mutex_init(&qs.mutex, NULL);
    pthread_cond_init(&qs.cond, NULL);

    require_ok(
        boxlite_api_key_credential_new(api_key, &credential, &error),
        "credential",
        &error
    );
    require_ok(boxlite_rest_options_new(api_url, &rest, &error), "rest options", &error);
    boxlite_rest_options_set_credential(rest, credential);
    require_ok(
        boxlite_rest_runtime_new_with_options(rest, &qs.runtime, &error),
        "rest runtime",
        &error
    );
    DrainLoop loop = {.runtime = qs.runtime, .stop = 0};
    pthread_t drain_thread;
    pthread_create(&drain_thread, NULL, drain_loop, &loop);

    require_ok(
        boxlite_options_new(
            "ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3",
            &box_options,
            &error
        ),
        "box options",
        &error
    );
    char box_name[64];
    snprintf(box_name, sizeof(box_name), "sdk-quickstart-c-%ld", (long)time(NULL));
    boxlite_options_set_name(box_options, box_name);
    prepare_wait(&qs);
    require_ok(
        boxlite_create_box(qs.runtime, box_options, on_create, &qs, &error),
        "create box",
        &error
    );
    wait_until_done(&qs);

    prepare_wait(&qs);
    require_ok(boxlite_start_box(qs.box, on_done, &qs, &error), "start box", &error);
    wait_until_done(&qs);

    const char *args[] = {"Hello from BoxLite C SDK"};
    BoxliteCommand cmd = {.command = "echo", .args = args, .argc = 1};
    require_ok(boxlite_box_exec(qs.box, &cmd, &qs.exec, &error), "exec", &error);
    require_ok(
        boxlite_execution_on_stdout(qs.exec, on_stdout, NULL, &error),
        "stdout",
        &error
    );
    require_ok(boxlite_execution_stdin_close(qs.exec, &error), "stdin close", &error);
    prepare_wait(&qs);
    require_ok(boxlite_execution_wait(qs.exec, on_wait, &qs, &error), "wait", &error);
    wait_until_done(&qs);
    printf("Exit code: %d\n", qs.exit_code);

    char *box_id = boxlite_box_id(qs.box);
    prepare_wait(&qs);
    require_ok(
        boxlite_remove(qs.runtime, box_id, 1, on_done, &qs, &error),
        "remove box",
        &error
    );
    wait_until_done(&qs);
    boxlite_free_string(box_id);

    loop.stop = 1;
    pthread_join(drain_thread, NULL);
    boxlite_execution_free(qs.exec);
    boxlite_box_free(qs.box);
    boxlite_rest_options_free(rest);
    boxlite_credential_free(credential);
    boxlite_runtime_free(qs.runtime);
    pthread_mutex_destroy(&qs.mutex);
    pthread_cond_destroy(&qs.cond);
    return qs.exit_code;
}
