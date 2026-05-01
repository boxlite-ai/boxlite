/**
 * BoxLite C SDK - Example 3: Streaming output callbacks.
 */

#include "example_common.h"
#include <stdio.h>
#include <string.h>

typedef struct {
  int stdout_chunks;
  int stderr_chunks;
  size_t total_bytes;
} OutputStats;

static void realtime_output(const char *text, int is_stderr, void *user_data) {
  (void)user_data;
  FILE *stream = is_stderr ? stderr : stdout;
  fprintf(stream, "%s", text ? text : "");
}

static void stats_callback(const char *text, int is_stderr, void *user_data) {
  OutputStats *stats = (OutputStats *)user_data;
  if (is_stderr) {
    stats->stderr_chunks++;
  } else {
    stats->stdout_chunks++;
  }
  if (text != NULL) {
    stats->total_bytes += strlen(text);
    printf("%s", text);
  }
}

int main(void) {
  printf("=== BoxLite Example: Streaming Output ===\n\n");

  CBoxliteRuntime *runtime = create_runtime_or_exit();
  if (runtime == NULL) {
    return 1;
  }

  CBoxHandle *box = create_alpine_box_or_exit(runtime);
  if (box == NULL) {
    boxlite_runtime_free(runtime);
    return 1;
  }

  CBoxliteError error = {0};
  int exit_code = 0;

  printf("1. Simple real-time output (ls /bin)\n");
  const char *const list_bin_args[] = {"/bin"};
  BoxliteErrorCode code = boxlite_execute(
      box, "/bin/ls", list_bin_args, 1, realtime_output, NULL, &exit_code,
      &error);
  if (code != Ok) {
    print_error("ls /bin", &error);
    boxlite_error_free(&error);
  }
  printf("\nExit code: %d\n\n", exit_code);

  printf("2. Capturing output with statistics\n");
  OutputStats stats = {0};
  const char *const recursive_args[] = {"-R", "/"};
  exit_code = 0;
  code = boxlite_execute(box, "/bin/ls", recursive_args, 2, stats_callback,
                         &stats, &exit_code, &error);
  if (code != Ok) {
    print_error("ls -R /", &error);
    boxlite_error_free(&error);
  }
  printf("\nExit code: %d\n", exit_code);
  printf("stdout chunks=%d stderr chunks=%d bytes=%zu\n\n",
         stats.stdout_chunks, stats.stderr_chunks, stats.total_bytes);

  printf("3. Command with stdout and stderr\n");
  const char *const shell_args[] = {
      "-c", "echo 'This is stdout'; echo 'This is stderr' >&2"};
  exit_code = 0;
  code = boxlite_execute(box, "/bin/sh", shell_args, 2, realtime_output, NULL,
                         &exit_code, &error);
  if (code != Ok) {
    print_error("sh", &error);
    boxlite_error_free(&error);
  }
  printf("\nExit code: %d\n", exit_code);

  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
  boxlite_runtime_free(runtime);

  printf("\n=== Streaming Output Demo Complete ===\n");
  return 0;
}
