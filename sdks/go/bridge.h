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
extern CBoxGetBoxCb cbGetBox(void);
extern CBoxStartBoxCb cbStartBox(void);
extern CBoxStopBoxCb cbStopBox(void);
extern CBoxRemoveBoxCb cbRemoveBox(void);
extern CBoxCopyCb cbCopy(void);

extern CBoxImagePullCb cbImagePull(void);
extern CBoxImageListCb cbImageList(void);

extern CBoxInfoCb cbInfo(void);
extern CBoxInfoListCb cbInfoList(void);

extern CBoxMetricsCb cbBoxMetrics(void);
extern CRuntimeMetricsCb cbRuntimeMetrics(void);

extern CRuntimeShutdownCb cbRuntimeShutdown(void);

extern CExecutionWaitCb cbExecutionWait(void);
extern CExecutionKillCb cbExecutionKill(void);
extern CExecutionResizeCb cbExecutionResize(void);

#endif // BOXLITE_GO_BRIDGE_H
