#include "boxlite.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void check(enum BoxliteErrorCode code, CBoxliteError *err) {
    if (code != Ok) {
        fprintf(stderr, "BoxLite error %d: %s\n", code, err->message ? err->message : "");
        boxlite_error_free(err);
        exit(1);
    }
}

static void json_string(const char *value) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
        if (*p == '"' || *p == '\\') putchar('\\');
        if (*p < 32) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}

static void domain(const CDomain *d) {
    printf("{\"hostname\":");
    json_string(d->hostname);
    printf(",\"url\":");
    json_string(d->url);
    printf(",\"target\":");
    if (d->target.box) {
        assert(d->target.type == BoxliteDomainTargetBox && !d->target.app);
        printf("{\"type\":\"box\",\"box\":");
        json_string(d->target.box);
        printf(",\"port\":%u}", d->target.port);
    } else if (d->target.app) {
        assert(d->target.type == BoxliteDomainTargetApp);
        printf("{\"type\":\"app\",\"app\":");
        json_string(d->target.app);
        putchar('}');
    } else {
        printf("null");
    }
    putchar('}');
}

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    if (strcmp(argv[1], "bind") == 0 && argc != 4) return 2;
    if (strcmp(argv[1], "unbind") == 0 && argc != 3) return 2;
    CBoxliteError err = {0};
    CBoxliteRestOptions *options = NULL;
    CBoxliteCredential *credential = NULL;
    CBoxliteRuntime *runtime = NULL;
    CBoxliteDomainHandle *handle = NULL;
    check(boxlite_rest_options_new(getenv("BOXLITE_E2E_URL"), &options, &err), &err);
    check(boxlite_api_key_credential_new(getenv("BOXLITE_E2E_API_KEY"), &credential, &err), &err);
    boxlite_rest_options_set_credential(options, credential);
    boxlite_rest_options_set_path_prefix(options, getenv("BOXLITE_E2E_PREFIX"));
    check(boxlite_rest_runtime_new_with_options(options, &runtime, &err), &err);
    boxlite_rest_options_free(options);
    boxlite_credential_free(credential);
    check(boxlite_runtime_domains(runtime, &handle, &err), &err);

    if (strcmp(argv[1], "list") == 0) {
        CDomainList *held = NULL;
        check(boxlite_domain_list(handle, &held, &err), &err);
        printf("{\"domains\":[");
        for (int i = 0; i < held->count; i++) {
            if (i) putchar(',');
            domain(&held->items[i]);
        }
        printf("],\"limit\":%u,\"used\":%u,\"remaining\":%u,\"min_length\":%u}\n",
               held->limit, held->used, held->remaining, held->min_length);
        boxlite_free_domain_list(held);
    } else if (strcmp(argv[1], "unbind") == 0) {
        check(boxlite_domain_unbind(handle, argv[2], &err), &err);
        puts("{}");
    } else if (strcmp(argv[1], "bind") == 0) {
        char *end = NULL;
        unsigned long port = strtoul(argv[3], &end, 10);
        if (*end || port == 0 || port > 65535) return 2;
        CDomainTarget target = {0};
        target.type = BoxliteDomainTargetBox;
        target.box = getenv("BOXLITE_E2E_BOX");
        target.port = (uint16_t)port;
        CDomain *bound = NULL;
        check(boxlite_domain_bind(handle, argv[2], &target, &bound, &err), &err);
        domain(bound);
        putchar('\n');
        boxlite_free_domain(bound);
    } else {
        return 2;
    }
    boxlite_free_domain_handle(handle);
    boxlite_runtime_free(runtime);
    return 0;
}
