// Bridge accessor declarations for the Go-exported callback symbols.
// Implementation lives in bridge.c; consumers include this header in their
// cgo preamble to call C.cbXxx() from Go.

#ifndef BOXLITE_GO_BRIDGE_H
#define BOXLITE_GO_BRIDGE_H

#include "boxlite.h"

extern CBoxStdoutCb cbStdout(void);
extern CBoxStderrCb cbStderr(void);
extern CBoxExitCb cbExit(void);

extern CBoxCreateBoxCb cbCreateBox(void);
extern CBoxGetOrCreateBoxCb cbGetOrCreateBox(void);
extern CBoxGetBoxCb cbGetBox(void);
extern CBoxStartBoxCb cbStartBox(void);
extern CBoxStopBoxCb cbStopBox(void);
extern CBoxRemoveBoxCb cbRemoveBox(void);
extern CBoxCopyCb cbCopy(void);

extern CBoxImagePullCb cbImagePull(void);
extern CBoxImageListCb cbImageList(void);

extern CBoxVolumeCreateCb cbVolumeCreate(void);
extern CBoxVolumeListCb cbVolumeList(void);
extern CBoxVolumeGetCb cbVolumeGet(void);
extern CBoxVolumeRemoveCb cbVolumeRemove(void);

extern CBoxInfoCb cbInfo(void);
extern CBoxInfoListCb cbInfoList(void);

extern CBoxMetricsCb cbBoxMetrics(void);
extern CRuntimeMetricsCb cbRuntimeMetrics(void);

extern CRuntimeShutdownCb cbRuntimeShutdown(void);

// Private bridge into the Rust core: create-time guest SSH CA trust.
//
// Declared here rather than in boxlite.h because the C SDK exposes no SSH
// surface — cbindgen is told to skip this symbol (sdks/c/cbindgen.toml,
// `[export] exclude`), so this prototype is the only declaration of it and
// must stay byte-compatible with the Rust signature in sdks/c/src/options.rs.
//
// ca_key_ids[i] and ca_public_keys[i] describe the same CA; both arrays hold
// ca_key_count entries. Returns InvalidArgument, leaving opts untouched, for a
// NULL/blank identity field or a missing/empty CA key array.
extern enum BoxliteErrorCode boxlite_go_options_set_guest_ssh_trust(CBoxliteOptions *opts,
                                                                   const char *listen_addr,
                                                                   const char *organization_id,
                                                                   const char *box_id,
                                                                   const char *const *ca_key_ids,
                                                                   const char *const *ca_public_keys,
                                                                   int ca_key_count);

extern CExecutionWaitCb cbExecutionWait(void);
extern CExecutionKillCb cbExecutionKill(void);
extern CExecutionSignalCb cbExecutionSignal(void);
extern CExecutionResizeCb cbExecutionResize(void);

#endif // BOXLITE_GO_BRIDGE_H
