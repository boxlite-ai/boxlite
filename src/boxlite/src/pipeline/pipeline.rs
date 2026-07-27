//! Generic pipeline execution framework.
//!
//! Provides a table-driven pipeline executor that can run stages containing tasks
//! in parallel or sequential mode.

use super::metrics::{PipelineMetrics, StageMetrics, TaskMetrics};
use super::stage::{ExecutionMode, Stage};
use super::task::BoxedTask;
use boxlite_shared::errors::BoxliteResult;
use futures::future::join_all;
use std::time::Instant;

pub struct ExecutionPlan<Ctx> {
    stages: Vec<Stage<BoxedTask<Ctx>>>,
}

impl<Ctx> ExecutionPlan<Ctx> {
    pub fn new(stages: Vec<Stage<BoxedTask<Ctx>>>) -> Self {
        Self { stages }
    }

    pub fn stages(self) -> Vec<Stage<BoxedTask<Ctx>>> {
        self.stages
    }
}

pub struct Pipeline<Ctx> {
    stages: Vec<Stage<BoxedTask<Ctx>>>,
}

impl<Ctx> Pipeline<Ctx> {
    pub fn new(stages: Vec<Stage<BoxedTask<Ctx>>>) -> Self {
        Self { stages }
    }
}

pub struct PipelineBuilder;

impl PipelineBuilder {
    pub fn from_plan<Ctx>(plan: ExecutionPlan<Ctx>) -> Pipeline<Ctx> {
        Pipeline::new(plan.stages())
    }
}

/// Pipeline executor framework.
///
/// This provides the generic infrastructure for executing a table-driven pipeline.
/// The actual task execution logic is provided by task implementations.
pub struct PipelineExecutor;

impl PipelineExecutor {
    /// Execute a pipeline.
    ///
    /// This is the core pipeline execution loop. It iterates through stages
    /// and executes their tasks according to the stage's execution mode.
    ///
    /// Generic over:
    /// - `Ctx`: Shared pipeline context (use interior mutability for writes)
    pub async fn execute<Ctx>(pipeline: Pipeline<Ctx>, ctx: Ctx) -> BoxliteResult<PipelineMetrics>
    where
        Ctx: Clone,
    {
        let total_start = Instant::now();
        let mut stage_metrics = Vec::new();

        for (index, stage) in pipeline.stages.into_iter().enumerate() {
            let execution = stage.execution;
            let stage_start = Instant::now();

            let task_metrics = match execution {
                ExecutionMode::Parallel => {
                    let futures = stage.tasks.into_iter().map(|task| {
                        let ctx = ctx.clone();
                        async move {
                            let name = task.name().to_string();
                            let task_start = Instant::now();
                            task.run(ctx).await?;
                            Ok::<TaskMetrics, boxlite_shared::errors::BoxliteError>(TaskMetrics {
                                name,
                                duration_ms: task_start.elapsed().as_millis(),
                            })
                        }
                    });
                    // Every started task may own side effects that require an
                    // async completion path. Wait for all siblings before
                    // returning the first error in declaration order; a
                    // fail-fast join would cancel those cleanup paths.
                    join_all(futures)
                        .await
                        .into_iter()
                        .collect::<BoxliteResult<Vec<_>>>()?
                }
                ExecutionMode::Sequential => {
                    let mut task_metrics = Vec::new();
                    for task in stage.tasks {
                        let name = task.name().to_string();
                        let task_start = Instant::now();
                        task.run(ctx.clone()).await?;
                        task_metrics.push(TaskMetrics {
                            name,
                            duration_ms: task_start.elapsed().as_millis(),
                        });
                    }
                    task_metrics
                }
            };

            stage_metrics.push(StageMetrics {
                index,
                execution,
                duration_ms: stage_start.elapsed().as_millis(),
                tasks: task_metrics,
            });
        }

        Ok(PipelineMetrics {
            total_duration_ms: total_start.elapsed().as_millis(),
            stages: stage_metrics,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::PipelineTask;
    use async_trait::async_trait;
    use boxlite_shared::errors::BoxliteError;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Barrier;

    #[derive(Clone)]
    struct ParallelTestContext {
        started: Arc<Barrier>,
        cleanup_finished: Arc<AtomicBool>,
    }

    struct FailingTask;

    #[async_trait]
    impl PipelineTask<ParallelTestContext> for FailingTask {
        async fn run(
            self: Box<Self>,
            ctx: ParallelTestContext,
        ) -> boxlite_shared::errors::BoxliteResult<()> {
            ctx.started.wait().await;
            Err(BoxliteError::Internal("parallel task failed".to_string()))
        }

        fn name(&self) -> &str {
            "failing"
        }
    }

    struct CleanupTask;

    #[async_trait]
    impl PipelineTask<ParallelTestContext> for CleanupTask {
        async fn run(
            self: Box<Self>,
            ctx: ParallelTestContext,
        ) -> boxlite_shared::errors::BoxliteResult<()> {
            ctx.started.wait().await;
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            ctx.cleanup_finished.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn name(&self) -> &str {
            "cleanup"
        }
    }

    #[tokio::test]
    async fn parallel_stage_waits_for_started_sibling_cleanup_before_returning_error() {
        let cleanup_finished = Arc::new(AtomicBool::new(false));
        let ctx = ParallelTestContext {
            started: Arc::new(Barrier::new(2)),
            cleanup_finished: Arc::clone(&cleanup_finished),
        };
        let pipeline = Pipeline::new(vec![Stage::parallel(vec![
            Box::new(FailingTask),
            Box::new(CleanupTask),
        ])]);

        let error = PipelineExecutor::execute(pipeline, ctx).await.unwrap_err();

        assert!(error.to_string().contains("parallel task failed"));
        assert!(
            cleanup_finished.load(Ordering::SeqCst),
            "parallel siblings must finish cleanup before the stage returns"
        );
    }
}
