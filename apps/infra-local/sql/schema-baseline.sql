--
-- PostgreSQL database dump
--

\restrict KftFD8TEkHDtpS3HApQOAtpKsWvZExhaQpj2QDujpccssvchzHowokD6rX9WrlG

-- Dumped from database version 17.9
-- Dumped by pg_dump version 17.6 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: api_key_permissions_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.api_key_permissions_enum AS ENUM (
    'write:registries',
    'delete:registries',
    'write:snapshots',
    'delete:snapshots',
    'write:sandboxes',
    'delete:sandboxes',
    'read:volumes',
    'write:volumes',
    'delete:volumes',
    'write:regions',
    'delete:regions',
    'read:runners',
    'write:runners',
    'delete:runners',
    'read:audit_logs'
);


--
-- Name: docker_registry_registrytype_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.docker_registry_registrytype_enum AS ENUM (
    'internal',
    'organization',
    'transient',
    'backup'
);


--
-- Name: job_resourcetype_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.job_resourcetype_enum AS ENUM (
    'SANDBOX',
    'SNAPSHOT',
    'BACKUP'
);


--
-- Name: job_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.job_status_enum AS ENUM (
    'PENDING',
    'IN_PROGRESS',
    'COMPLETED',
    'FAILED'
);


--
-- Name: organization_invitation_role_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.organization_invitation_role_enum AS ENUM (
    'owner',
    'member'
);


--
-- Name: organization_invitation_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.organization_invitation_status_enum AS ENUM (
    'pending',
    'accepted',
    'declined',
    'cancelled'
);


--
-- Name: organization_role_permissions_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.organization_role_permissions_enum AS ENUM (
    'write:registries',
    'delete:registries',
    'write:snapshots',
    'delete:snapshots',
    'write:sandboxes',
    'delete:sandboxes',
    'read:volumes',
    'write:volumes',
    'delete:volumes',
    'write:regions',
    'delete:regions',
    'read:runners',
    'write:runners',
    'delete:runners',
    'read:audit_logs'
);


--
-- Name: organization_user_role_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.organization_user_role_enum AS ENUM (
    'owner',
    'member'
);


--
-- Name: region_regiontype_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.region_regiontype_enum AS ENUM (
    'shared',
    'dedicated',
    'custom'
);


--
-- Name: runner_class_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.runner_class_enum AS ENUM (
    'small',
    'medium',
    'large'
);


--
-- Name: runner_state_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.runner_state_enum AS ENUM (
    'initializing',
    'ready',
    'disabled',
    'decommissioned',
    'unresponsive'
);


--
-- Name: sandbox_backupstate_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sandbox_backupstate_enum AS ENUM (
    'None',
    'Pending',
    'InProgress',
    'Completed',
    'Error'
);


--
-- Name: sandbox_class_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sandbox_class_enum AS ENUM (
    'small',
    'medium',
    'large'
);


--
-- Name: sandbox_desiredstate_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sandbox_desiredstate_enum AS ENUM (
    'destroyed',
    'started',
    'stopped',
    'resized',
    'archived'
);


--
-- Name: sandbox_state_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sandbox_state_enum AS ENUM (
    'creating',
    'restoring',
    'destroyed',
    'destroying',
    'started',
    'stopped',
    'starting',
    'stopping',
    'error',
    'build_failed',
    'pending_build',
    'building_snapshot',
    'unknown',
    'pulling_snapshot',
    'archiving',
    'archived',
    'resizing'
);


--
-- Name: snapshot_runner_state_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.snapshot_runner_state_enum AS ENUM (
    'pulling_snapshot',
    'building_snapshot',
    'ready',
    'error',
    'removing'
);


--
-- Name: snapshot_state_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.snapshot_state_enum AS ENUM (
    'pending',
    'pulling',
    'active',
    'inactive',
    'building',
    'error',
    'build_failed',
    'removing'
);


--
-- Name: user_role_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role_enum AS ENUM (
    'admin',
    'user'
);


--
-- Name: volume_state_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.volume_state_enum AS ENUM (
    'creating',
    'ready',
    'pending_create',
    'pending_delete',
    'deleting',
    'deleted',
    'error'
);


--
-- Name: warm_pool_class_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.warm_pool_class_enum AS ENUM (
    'small',
    'medium',
    'large'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_key (
    "userId" character varying NOT NULL,
    name character varying NOT NULL,
    "createdAt" timestamp without time zone NOT NULL,
    "organizationId" uuid NOT NULL,
    permissions public.api_key_permissions_enum[] NOT NULL,
    "keyHash" character varying DEFAULT ''::character varying NOT NULL,
    "keyPrefix" character varying DEFAULT ''::character varying NOT NULL,
    "keySuffix" character varying DEFAULT ''::character varying NOT NULL,
    "lastUsedAt" timestamp without time zone,
    "expiresAt" timestamp without time zone
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "actorId" character varying NOT NULL,
    "actorEmail" character varying DEFAULT ''::character varying NOT NULL,
    "organizationId" character varying,
    action character varying NOT NULL,
    "targetType" character varying,
    "targetId" character varying,
    "statusCode" integer,
    "errorMessage" character varying,
    "ipAddress" character varying,
    "userAgent" text,
    source character varying,
    metadata jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: build_info; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.build_info (
    "snapshotRef" character varying NOT NULL,
    "dockerfileContent" text,
    "contextHashes" text,
    "lastUsedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: docker_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.docker_registry (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    url character varying NOT NULL,
    username character varying NOT NULL,
    password character varying NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    project character varying DEFAULT ''::character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "registryType" public.docker_registry_registrytype_enum DEFAULT 'internal'::public.docker_registry_registrytype_enum NOT NULL,
    "organizationId" uuid,
    region character varying,
    "isFallback" boolean DEFAULT false NOT NULL
);


--
-- Name: job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    version integer NOT NULL,
    type character varying NOT NULL,
    status public.job_status_enum DEFAULT 'PENDING'::public.job_status_enum NOT NULL,
    "runnerId" character varying NOT NULL,
    "resourceType" public.job_resourcetype_enum NOT NULL,
    "resourceId" character varying NOT NULL,
    payload character varying,
    "resultMetadata" character varying,
    "traceContext" jsonb,
    "errorMessage" text,
    "startedAt" timestamp with time zone,
    "completedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migrations (
    id integer NOT NULL,
    "timestamp" bigint NOT NULL,
    name character varying NOT NULL
);


--
-- Name: migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.migrations_id_seq OWNED BY public.migrations.id;


--
-- Name: organization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    "createdBy" character varying NOT NULL,
    personal boolean DEFAULT false NOT NULL,
    "telemetryEnabled" boolean DEFAULT true NOT NULL,
    max_cpu_per_sandbox integer DEFAULT 4 NOT NULL,
    max_memory_per_sandbox integer DEFAULT 8 NOT NULL,
    max_disk_per_sandbox integer DEFAULT 10 NOT NULL,
    snapshot_quota integer DEFAULT 100 NOT NULL,
    max_snapshot_size integer DEFAULT 20 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    suspended boolean DEFAULT false NOT NULL,
    "suspensionReason" character varying,
    "suspendedUntil" timestamp with time zone,
    "suspendedAt" timestamp with time zone,
    volume_quota integer DEFAULT 100 NOT NULL,
    "suspensionCleanupGracePeriodHours" integer DEFAULT 24 NOT NULL,
    "sandboxLimitedNetworkEgress" boolean DEFAULT false NOT NULL,
    authenticated_rate_limit integer,
    sandbox_create_rate_limit integer,
    sandbox_lifecycle_rate_limit integer,
    "defaultRegionId" character varying,
    "experimentalConfig" jsonb,
    authenticated_rate_limit_ttl_seconds integer,
    sandbox_create_rate_limit_ttl_seconds integer,
    sandbox_lifecycle_rate_limit_ttl_seconds integer,
    snapshot_deactivation_timeout_minutes integer DEFAULT 20160 NOT NULL
);


--
-- Name: organization_invitation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_invitation (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "organizationId" uuid NOT NULL,
    email character varying NOT NULL,
    role public.organization_invitation_role_enum DEFAULT 'member'::public.organization_invitation_role_enum NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    status public.organization_invitation_status_enum DEFAULT 'pending'::public.organization_invitation_status_enum NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "invitedBy" character varying DEFAULT ''::character varying NOT NULL
);


--
-- Name: organization_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_role (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    description character varying NOT NULL,
    permissions public.organization_role_permissions_enum[] NOT NULL,
    "isGlobal" boolean DEFAULT false NOT NULL,
    "organizationId" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organization_role_assignment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_role_assignment (
    "organizationId" uuid NOT NULL,
    "userId" character varying NOT NULL,
    "roleId" uuid NOT NULL
);


--
-- Name: organization_role_assignment_invitation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_role_assignment_invitation (
    "invitationId" uuid NOT NULL,
    "roleId" uuid NOT NULL
);


--
-- Name: organization_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_user (
    "organizationId" uuid NOT NULL,
    "userId" character varying NOT NULL,
    role public.organization_user_role_enum DEFAULT 'member'::public.organization_user_role_enum NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: region; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.region (
    id character varying NOT NULL,
    name character varying NOT NULL,
    "organizationId" uuid,
    "enforceQuotas" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "regionType" public.region_regiontype_enum NOT NULL,
    "proxyUrl" character varying,
    "toolboxProxyUrl" character varying,
    "proxyApiKeyHash" character varying,
    "sshGatewayUrl" character varying,
    "sshGatewayApiKeyHash" character varying,
    "snapshotManagerUrl" character varying,
    CONSTRAINT region_not_custom CHECK ((("organizationId" IS NOT NULL) OR ("regionType" <> 'custom'::public.region_regiontype_enum))),
    CONSTRAINT region_not_shared CHECK ((("organizationId" IS NULL) OR ("regionType" <> 'shared'::public.region_regiontype_enum)))
);


--
-- Name: region_quota; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.region_quota (
    "organizationId" uuid NOT NULL,
    "regionId" character varying NOT NULL,
    total_cpu_quota integer DEFAULT 10 NOT NULL,
    total_memory_quota integer DEFAULT 10 NOT NULL,
    total_disk_quota integer DEFAULT 30 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: runner; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runner (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    domain character varying,
    "apiUrl" character varying,
    "apiKey" character varying NOT NULL,
    cpu double precision DEFAULT '0'::double precision NOT NULL,
    "memoryGiB" double precision DEFAULT '0'::double precision NOT NULL,
    "diskGiB" double precision DEFAULT '0'::double precision NOT NULL,
    gpu integer,
    "gpuType" character varying,
    class public.runner_class_enum DEFAULT 'small'::public.runner_class_enum NOT NULL,
    region character varying NOT NULL,
    state public.runner_state_enum DEFAULT 'initializing'::public.runner_state_enum NOT NULL,
    "lastChecked" timestamp with time zone,
    unschedulable boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "currentCpuUsagePercentage" double precision DEFAULT '0'::double precision NOT NULL,
    "currentMemoryUsagePercentage" double precision DEFAULT '0'::double precision NOT NULL,
    "currentDiskUsagePercentage" double precision DEFAULT '0'::double precision NOT NULL,
    "currentAllocatedCpu" double precision DEFAULT 0 NOT NULL,
    "currentAllocatedMemoryGiB" double precision DEFAULT 0 NOT NULL,
    "currentAllocatedDiskGiB" double precision DEFAULT 0 NOT NULL,
    "currentSnapshotCount" integer DEFAULT 0 NOT NULL,
    "availabilityScore" integer DEFAULT 0 NOT NULL,
    "apiVersion" character varying DEFAULT '0'::character varying NOT NULL,
    "proxyUrl" character varying,
    name character varying NOT NULL,
    "currentStartedSandboxes" integer DEFAULT 0 NOT NULL,
    "appVersion" character varying DEFAULT 'v0.0.0-dev'::character varying,
    "currentCpuLoadAverage" double precision DEFAULT '0'::double precision NOT NULL,
    draining boolean DEFAULT false NOT NULL,
    "serviceHealth" jsonb
);


--
-- Name: sandbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox (
    id character varying DEFAULT public.uuid_generate_v4() NOT NULL,
    region character varying NOT NULL,
    "runnerId" uuid,
    "prevRunnerId" uuid,
    class public.sandbox_class_enum DEFAULT 'small'::public.sandbox_class_enum NOT NULL,
    state public.sandbox_state_enum DEFAULT 'unknown'::public.sandbox_state_enum NOT NULL,
    "desiredState" public.sandbox_desiredstate_enum DEFAULT 'started'::public.sandbox_desiredstate_enum NOT NULL,
    snapshot character varying,
    "osUser" character varying NOT NULL,
    "errorReason" character varying,
    env jsonb DEFAULT '{}'::jsonb NOT NULL,
    public boolean DEFAULT false NOT NULL,
    labels jsonb,
    "backupRegistryId" character varying,
    "backupSnapshot" character varying,
    "lastBackupAt" timestamp with time zone,
    "backupState" public.sandbox_backupstate_enum DEFAULT 'None'::public.sandbox_backupstate_enum NOT NULL,
    "existingBackupSnapshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
    cpu integer DEFAULT 2 NOT NULL,
    gpu integer DEFAULT 0 NOT NULL,
    mem integer DEFAULT 4 NOT NULL,
    disk integer DEFAULT 10 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "autoStopInterval" integer DEFAULT 15 NOT NULL,
    "organizationId" uuid NOT NULL,
    pending boolean DEFAULT false NOT NULL,
    "authToken" character varying NOT NULL,
    volumes jsonb DEFAULT '[]'::jsonb NOT NULL,
    "buildInfoSnapshotRef" character varying,
    "autoArchiveInterval" integer DEFAULT 10080 NOT NULL,
    "daemonVersion" character varying,
    "autoDeleteInterval" integer DEFAULT '-1'::integer NOT NULL,
    "networkBlockAll" boolean DEFAULT false NOT NULL,
    "networkAllowList" character varying,
    "backupErrorReason" text,
    name character varying NOT NULL,
    recoverable boolean DEFAULT false NOT NULL
);


--
-- Name: sandbox_last_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_last_activity (
    "sandboxId" character varying NOT NULL,
    "lastActivityAt" timestamp with time zone
);


--
-- Name: sandbox_usage_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_usage_periods (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "sandboxId" character varying NOT NULL,
    "startAt" timestamp with time zone NOT NULL,
    "endAt" timestamp with time zone,
    cpu double precision NOT NULL,
    gpu double precision NOT NULL,
    mem double precision NOT NULL,
    disk double precision NOT NULL,
    region character varying NOT NULL,
    "organizationId" character varying NOT NULL
);


--
-- Name: sandbox_usage_periods_archive; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_usage_periods_archive (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "sandboxId" character varying NOT NULL,
    "organizationId" character varying NOT NULL,
    "startAt" timestamp with time zone NOT NULL,
    "endAt" timestamp with time zone NOT NULL,
    cpu double precision NOT NULL,
    gpu double precision NOT NULL,
    mem double precision NOT NULL,
    disk double precision NOT NULL,
    region character varying NOT NULL
);


--
-- Name: snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snapshot (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    general boolean DEFAULT false NOT NULL,
    name character varying NOT NULL,
    ref character varying,
    state public.snapshot_state_enum DEFAULT 'pending'::public.snapshot_state_enum NOT NULL,
    "errorReason" character varying,
    size double precision,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "lastUsedAt" timestamp without time zone,
    "organizationId" uuid,
    entrypoint text[],
    "buildInfoSnapshotRef" character varying,
    "initialRunnerId" character varying,
    "imageName" character varying DEFAULT ''::character varying NOT NULL,
    cpu integer DEFAULT 1 NOT NULL,
    gpu integer DEFAULT 0 NOT NULL,
    mem integer DEFAULT 1 NOT NULL,
    disk integer DEFAULT 3 NOT NULL,
    "hideFromUsers" boolean DEFAULT false NOT NULL
);


--
-- Name: snapshot_region; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snapshot_region (
    "snapshotId" uuid NOT NULL,
    "regionId" character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: snapshot_runner; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snapshot_runner (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    state public.snapshot_runner_state_enum DEFAULT 'pulling_snapshot'::public.snapshot_runner_state_enum NOT NULL,
    "errorReason" character varying,
    "snapshotRef" character varying DEFAULT ''::character varying NOT NULL,
    "runnerId" character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ssh_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ssh_access (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "sandboxId" character varying NOT NULL,
    token text NOT NULL,
    "expiresAt" timestamp without time zone NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "unixUser" text
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id character varying NOT NULL,
    name character varying NOT NULL,
    "keyPair" text,
    "publicKeys" text NOT NULL,
    email character varying DEFAULT ''::character varying NOT NULL,
    role public.user_role_enum DEFAULT 'user'::public.user_role_enum NOT NULL,
    "emailVerified" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: volume; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.volume (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "organizationId" uuid,
    name character varying NOT NULL,
    "errorReason" character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "lastUsedAt" timestamp without time zone,
    state public.volume_state_enum DEFAULT 'pending_create'::public.volume_state_enum NOT NULL
);


--
-- Name: warm_pool; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warm_pool (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    pool integer NOT NULL,
    snapshot character varying NOT NULL,
    target character varying NOT NULL,
    cpu integer NOT NULL,
    mem integer NOT NULL,
    disk integer NOT NULL,
    gpu integer NOT NULL,
    "gpuType" character varying NOT NULL,
    class public.warm_pool_class_enum DEFAULT 'small'::public.warm_pool_class_enum NOT NULL,
    "osUser" character varying NOT NULL,
    "errorReason" character varying,
    env text DEFAULT '{}'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: webhook_initialization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_initialization (
    "organizationId" character varying NOT NULL,
    "svixApplicationId" character varying,
    "lastError" text,
    "retryCount" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations ALTER COLUMN id SET DEFAULT nextval('public.migrations_id_seq'::regclass);


--
-- Name: docker_registry PK_4ad72294240279415eb57799798; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docker_registry
    ADD CONSTRAINT "PK_4ad72294240279415eb57799798" PRIMARY KEY (id);


--
-- Name: snapshot_runner PK_6c66fc8bd2b9fb41362a50fddd0; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot_runner
    ADD CONSTRAINT "PK_6c66fc8bd2b9fb41362a50fddd0" PRIMARY KEY (id);


--
-- Name: runner PK_8c8caf5f29d25264abe9eaf94dd; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner
    ADD CONSTRAINT "PK_8c8caf5f29d25264abe9eaf94dd" PRIMARY KEY (id);


--
-- Name: sandbox_usage_periods PK_b8d71f79ee638064397f678e877; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_usage_periods
    ADD CONSTRAINT "PK_b8d71f79ee638064397f678e877" PRIMARY KEY (id);


--
-- Name: user PK_cace4a159ff9f2512dd42373760; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT "PK_cace4a159ff9f2512dd42373760" PRIMARY KEY (id);


--
-- Name: snapshot PK_d6db1ab4ee9ad9dbe86c64e4cc3; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot
    ADD CONSTRAINT "PK_d6db1ab4ee9ad9dbe86c64e4cc3" PRIMARY KEY (id);


--
-- Name: warm_pool PK_fb06a13baeb3ac0ced145345d90; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warm_pool
    ADD CONSTRAINT "PK_fb06a13baeb3ac0ced145345d90" PRIMARY KEY (id);


--
-- Name: snapshot_region PK_snapshot_region; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot_region
    ADD CONSTRAINT "PK_snapshot_region" PRIMARY KEY ("snapshotId", "regionId");


--
-- Name: api_key api_key_keyHash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT "api_key_keyHash_unique" UNIQUE ("keyHash");


--
-- Name: api_key api_key_userId_name_organizationId_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT "api_key_userId_name_organizationId_pk" PRIMARY KEY ("userId", name, "organizationId");


--
-- Name: audit_log audit_log_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_id_pk PRIMARY KEY (id);


--
-- Name: build_info build_info_snapshotRef_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_info
    ADD CONSTRAINT "build_info_snapshotRef_pk" PRIMARY KEY ("snapshotRef");


--
-- Name: job job_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job
    ADD CONSTRAINT job_id_pk PRIMARY KEY (id);


--
-- Name: migrations migrations_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT migrations_id_pk PRIMARY KEY (id);


--
-- Name: organization organization_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_id_pk PRIMARY KEY (id);


--
-- Name: organization_invitation organization_invitation_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_invitation
    ADD CONSTRAINT organization_invitation_id_pk PRIMARY KEY (id);


--
-- Name: organization_role_assignment_invitation organization_role_assignment_invitation_invitationId_roleId_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_role_assignment_invitation
    ADD CONSTRAINT "organization_role_assignment_invitation_invitationId_roleId_pk" PRIMARY KEY ("invitationId", "roleId");


--
-- Name: organization_role_assignment organization_role_assignment_organizationId_userId_roleId_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_role_assignment
    ADD CONSTRAINT "organization_role_assignment_organizationId_userId_roleId_pk" PRIMARY KEY ("organizationId", "userId", "roleId");


--
-- Name: organization_role organization_role_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_role
    ADD CONSTRAINT organization_role_id_pk PRIMARY KEY (id);


--
-- Name: organization_user organization_user_organizationId_userId_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_user
    ADD CONSTRAINT "organization_user_organizationId_userId_pk" PRIMARY KEY ("organizationId", "userId");


--
-- Name: region region_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region
    ADD CONSTRAINT region_id_pk PRIMARY KEY (id);


--
-- Name: region_quota region_quota_organizationId_regionId_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_quota
    ADD CONSTRAINT "region_quota_organizationId_regionId_pk" PRIMARY KEY ("organizationId", "regionId");


--
-- Name: runner runner_region_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner
    ADD CONSTRAINT runner_region_name_unique UNIQUE (region, name);


--
-- Name: sandbox sandbox_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox
    ADD CONSTRAINT sandbox_id_pk PRIMARY KEY (id);


--
-- Name: sandbox_last_activity sandbox_last_activity_sandboxId_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_last_activity
    ADD CONSTRAINT "sandbox_last_activity_sandboxId_pk" PRIMARY KEY ("sandboxId");


--
-- Name: sandbox sandbox_organizationId_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox
    ADD CONSTRAINT "sandbox_organizationId_name_unique" UNIQUE ("organizationId", name);


--
-- Name: sandbox_usage_periods_archive sandbox_usage_periods_archive_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_usage_periods_archive
    ADD CONSTRAINT sandbox_usage_periods_archive_id_pk PRIMARY KEY (id);


--
-- Name: snapshot snapshot_organizationId_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot
    ADD CONSTRAINT "snapshot_organizationId_name_unique" UNIQUE ("organizationId", name);


--
-- Name: ssh_access ssh_access_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ssh_access
    ADD CONSTRAINT ssh_access_id_pk PRIMARY KEY (id);


--
-- Name: volume volume_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.volume
    ADD CONSTRAINT volume_id_pk PRIMARY KEY (id);


--
-- Name: volume volume_organizationId_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.volume
    ADD CONSTRAINT "volume_organizationId_name_unique" UNIQUE ("organizationId", name);


--
-- Name: webhook_initialization webhook_initialization_organizationId_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_initialization
    ADD CONSTRAINT "webhook_initialization_organizationId_pk" PRIMARY KEY ("organizationId");


--
-- Name: IDX_UNIQUE_INCOMPLETE_BACKUP_JOB; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_UNIQUE_INCOMPLETE_BACKUP_JOB" ON public.job USING btree ("resourceType", "resourceId", "runnerId") WHERE (("completedAt" IS NULL) AND ((type)::text = 'CREATE_BACKUP'::text));


--
-- Name: IDX_UNIQUE_INCOMPLETE_JOB; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_UNIQUE_INCOMPLETE_JOB" ON public.job USING btree ("resourceType", "resourceId", "runnerId") WHERE (("completedAt" IS NULL) AND ((type)::text <> 'CREATE_BACKUP'::text));


--
-- Name: api_key_org_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_key_org_user_idx ON public.api_key USING btree ("organizationId", "userId");


--
-- Name: audit_log_createdAt_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "audit_log_createdAt_index" ON public.audit_log USING btree ("createdAt");


--
-- Name: audit_log_organizationId_createdAt_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "audit_log_organizationId_createdAt_index" ON public.audit_log USING btree ("organizationId", "createdAt");


--
-- Name: docker_registry_organizationId_registryType_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "docker_registry_organizationId_registryType_index" ON public.docker_registry USING btree ("organizationId", "registryType");


--
-- Name: docker_registry_region_registryType_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "docker_registry_region_registryType_index" ON public.docker_registry USING btree (region, "registryType");


--
-- Name: docker_registry_registryType_isDefault_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "docker_registry_registryType_isDefault_index" ON public.docker_registry USING btree ("registryType", "isDefault");


--
-- Name: idx_region_custom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_region_custom ON public.region USING btree ("organizationId") WHERE ("regionType" = 'custom'::public.region_regiontype_enum);


--
-- Name: idx_sandbox_authtoken; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sandbox_authtoken ON public.sandbox USING btree ("authToken");


--
-- Name: idx_sandbox_usage_periods_sandbox_end; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sandbox_usage_periods_sandbox_end ON public.sandbox_usage_periods USING btree ("sandboxId", "endAt");


--
-- Name: idx_sandbox_volumes_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sandbox_volumes_gin ON public.sandbox USING gin (volumes jsonb_path_ops) WHERE ("desiredState" <> 'destroyed'::public.sandbox_desiredstate_enum);


--
-- Name: job_resourceType_resourceId_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "job_resourceType_resourceId_index" ON public.job USING btree ("resourceType", "resourceId");


--
-- Name: job_runnerId_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "job_runnerId_status_index" ON public.job USING btree ("runnerId", status);


--
-- Name: job_status_createdAt_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "job_status_createdAt_index" ON public.job USING btree (status, "createdAt");


--
-- Name: organization_role_assignment_invitation_invitationId_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "organization_role_assignment_invitation_invitationId_index" ON public.organization_role_assignment_invitation USING btree ("invitationId");


--
-- Name: organization_role_assignment_invitation_roleId_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "organization_role_assignment_invitation_roleId_index" ON public.organization_role_assignment_invitation USING btree ("roleId");


--
-- Name: organization_role_assignment_organizationId_userId_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "organization_role_assignment_organizationId_userId_index" ON public.organization_role_assignment USING btree ("organizationId", "userId");


--
-- Name: organization_role_assignment_roleId_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "organization_role_assignment_roleId_index" ON public.organization_role_assignment USING btree ("roleId");


--
-- Name: region_organizationId_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "region_organizationId_name_unique" ON public.region USING btree ("organizationId", name) WHERE ("organizationId" IS NOT NULL);


--
-- Name: region_organizationId_null_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "region_organizationId_null_name_unique" ON public.region USING btree (name) WHERE ("organizationId" IS NULL);


--
-- Name: region_proxyApiKeyHash_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "region_proxyApiKeyHash_unique" ON public.region USING btree ("proxyApiKeyHash") WHERE ("proxyApiKeyHash" IS NOT NULL);


--
-- Name: region_sshGatewayApiKeyHash_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "region_sshGatewayApiKeyHash_unique" ON public.region USING btree ("sshGatewayApiKeyHash") WHERE ("sshGatewayApiKeyHash" IS NOT NULL);


--
-- Name: runner_state_unschedulable_region_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runner_state_unschedulable_region_index ON public.runner USING btree (state, unschedulable, region);


--
-- Name: sandbox_active_only_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_active_only_idx ON public.sandbox USING btree (id) WHERE (state <> ALL (ARRAY['destroyed'::public.sandbox_state_enum, 'archived'::public.sandbox_state_enum]));


--
-- Name: sandbox_backupstate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_backupstate_idx ON public.sandbox USING btree ("backupState");


--
-- Name: sandbox_desiredstate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_desiredstate_idx ON public.sandbox USING btree ("desiredState");


--
-- Name: sandbox_labels_gin_full_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_labels_gin_full_idx ON public.sandbox USING gin (labels jsonb_path_ops);


--
-- Name: sandbox_organizationid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_organizationid_idx ON public.sandbox USING btree ("organizationId");


--
-- Name: sandbox_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_pending_idx ON public.sandbox USING btree (id) WHERE (pending = true);


--
-- Name: sandbox_region_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_region_idx ON public.sandbox USING btree (region);


--
-- Name: sandbox_resources_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_resources_idx ON public.sandbox USING btree (cpu, mem, disk, gpu);


--
-- Name: sandbox_runner_state_desired_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_runner_state_desired_idx ON public.sandbox USING btree ("runnerId", state, "desiredState") WHERE (pending = false);


--
-- Name: sandbox_runner_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_runner_state_idx ON public.sandbox USING btree ("runnerId", state);


--
-- Name: sandbox_runnerid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_runnerid_idx ON public.sandbox USING btree ("runnerId");


--
-- Name: sandbox_snapshot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_snapshot_idx ON public.sandbox USING btree (snapshot);


--
-- Name: sandbox_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandbox_state_idx ON public.sandbox USING btree (state);


--
-- Name: snapshot_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snapshot_name_idx ON public.snapshot USING btree (name);


--
-- Name: snapshot_runner_runnerid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snapshot_runner_runnerid_idx ON public.snapshot_runner USING btree ("runnerId");


--
-- Name: snapshot_runner_runnerid_snapshotref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snapshot_runner_runnerid_snapshotref_idx ON public.snapshot_runner USING btree ("runnerId", "snapshotRef");


--
-- Name: snapshot_runner_snapshotref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snapshot_runner_snapshotref_idx ON public.snapshot_runner USING btree ("snapshotRef");


--
-- Name: snapshot_runner_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snapshot_runner_state_idx ON public.snapshot_runner USING btree (state);


--
-- Name: snapshot_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snapshot_state_idx ON public.snapshot USING btree (state);


--
-- Name: warm_pool_find_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX warm_pool_find_idx ON public.warm_pool USING btree (snapshot, target, class, cpu, mem, disk, gpu, "osUser", env);


--
-- Name: organization_invitation organization_invitation_organizationId_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_invitation
    ADD CONSTRAINT "organization_invitation_organizationId_fk" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: organization_role_assignment_invitation organization_role_assignment_invitation_invitationId_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_role_assignment_invitation
    ADD CONSTRAINT "organization_role_assignment_invitation_invitationId_fk" FOREIGN KEY ("invitationId") REFERENCES public.organization_invitation(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: organization_role_assignment_invitation organization_role_assignment_invitation_roleId_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_role_assignment_invitation
    ADD CONSTRAINT "organization_role_assignment_invitation_roleId_fk" FOREIGN KEY ("roleId") REFERENCES public.organization_role(id);


--
-- Name: organization_role_assignment organization_role_assignment_organizationId_userId_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_role_assignment
    ADD CONSTRAINT "organization_role_assignment_organizationId_userId_fk" FOREIGN KEY ("organizationId", "userId") REFERENCES public.organization_user("organizationId", "userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: organization_role_assignment organization_role_assignment_roleId_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_role_assignment
    ADD CONSTRAINT "organization_role_assignment_roleId_fk" FOREIGN KEY ("roleId") REFERENCES public.organization_role(id);


--
-- Name: organization_role organization_role_organizationId_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_role
    ADD CONSTRAINT "organization_role_organizationId_fk" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: organization_user organization_user_organizationId_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_user
    ADD CONSTRAINT "organization_user_organizationId_fk" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: region_quota region_quota_organizationId_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_quota
    ADD CONSTRAINT "region_quota_organizationId_fk" FOREIGN KEY ("organizationId") REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: sandbox sandbox_buildInfoSnapshotRef_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox
    ADD CONSTRAINT "sandbox_buildInfoSnapshotRef_fk" FOREIGN KEY ("buildInfoSnapshotRef") REFERENCES public.build_info("snapshotRef");


--
-- Name: sandbox_last_activity sandbox_last_activity_sandboxId_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_last_activity
    ADD CONSTRAINT "sandbox_last_activity_sandboxId_fk" FOREIGN KEY ("sandboxId") REFERENCES public.sandbox(id) ON DELETE CASCADE;


--
-- Name: snapshot snapshot_buildInfoSnapshotRef_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot
    ADD CONSTRAINT "snapshot_buildInfoSnapshotRef_fk" FOREIGN KEY ("buildInfoSnapshotRef") REFERENCES public.build_info("snapshotRef");


--
-- Name: snapshot_region snapshot_region_regionId_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot_region
    ADD CONSTRAINT "snapshot_region_regionId_fk" FOREIGN KEY ("regionId") REFERENCES public.region(id) ON DELETE CASCADE;


--
-- Name: snapshot_region snapshot_region_snapshotId_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot_region
    ADD CONSTRAINT "snapshot_region_snapshotId_fk" FOREIGN KEY ("snapshotId") REFERENCES public.snapshot(id) ON DELETE CASCADE;


--
-- Name: ssh_access ssh_access_sandboxId_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ssh_access
    ADD CONSTRAINT "ssh_access_sandboxId_fk" FOREIGN KEY ("sandboxId") REFERENCES public.sandbox(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict KftFD8TEkHDtpS3HApQOAtpKsWvZExhaQpj2QDujpccssvchzHowokD6rX9WrlG

--
-- PostgreSQL database dump
--

\restrict BQt8nysWhOJA0csJpDgcEcy2TU3Z3SwOQna9axHduJbY5znGJ2pgEegmgJdv7Pf

-- Dumped from database version 17.9
-- Dumped by pg_dump version 17.6 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.migrations (id, "timestamp", name) FROM stdin;
1	1741087887225	Migration1741087887225
2	1741088165704	Migration1741088165704
3	1741088883000	Migration1741088883000
4	1741088883001	Migration1741088883001
5	1741088883002	Migration1741088883002
6	1741877019888	Migration1741877019888
7	1742215525714	Migration1742215525714
8	1742475055353	Migration1742475055353
9	1742831092942	Migration1742831092942
10	1743593463168	Migration1743593463168
11	1743683015304	Migration1743683015304
12	1744028841133	Migration1744028841133
13	1744114341077	Migration1744114341077
14	1744378115901	Migration1744378115901
15	1744808444807	Migration1744808444807
16	1744868914148	Migration1744868914148
17	1744971114480	Migration1744971114480
18	1745393243334	Migration1745393243334
19	1745494761360	Migration1745494761360
20	1745574377029	Migration1745574377029
21	1745840296260	Migration1745840296260
22	1745864972652	Migration1745864972652
23	1746354231722	Migration1746354231722
24	1746604150910	Migration1746604150910
25	1747658203010	Migration1747658203010
26	1748006546552	Migration1748006546552
27	1748866194353	Migration1748866194353
28	1749474791343	Migration1749474791343
29	1749474791344	Migration1749474791344
30	1749474791345	Migration1749474791345
31	1750077343089	Migration1750077343089
32	1750436374899	Migration1750436374899
33	1750668569562	Migration1750668569562
34	1750751712412	Migration1750751712412
35	1751456907334	Migration1751456907334
36	1752494676200	Migration1752494676200
37	1752494676205	Migration1752494676205
38	1752848014862	Migration1752848014862
39	1753099115783	Migration1753099115783
40	1753100751730	Migration1753100751730
41	1753100751731	Migration1753100751731
42	1753185133351	Migration1753185133351
43	1753274135567	Migration1753274135567
44	1753430929609	Migration1753430929609
45	1753717830378	Migration1753717830378
46	1754042247109	Migration1754042247109
47	1755003696741	Migration1755003696741
48	1755356869493	Migration1755356869493
49	1755464957487	Migration1755464957487
50	1755521645207	Migration1755521645207
51	1755860619921	Migration1755860619921
52	1757513754037	Migration1757513754037
53	1757513754038	Migration1757513754038
54	1759241690773	Migration1759241690773
55	1759768058397	Migration1759768058397
56	1761912147638	Migration1761912147638
57	1761912147639	Migration1761912147639
58	1763561822000	Migration1763561822000
59	1764073472179	Migration1764073472179
60	1764073472180	Migration1764073472180
61	1764844895057	Migration1764844895057
62	1764844895058	Migration1764844895058
63	1765282546000	Migration1765282546000
64	1765366773736	Migration1765366773736
65	1765400000000	Migration1765400000000
66	1765806205881	Migration1765806205881
67	1766415256696	Migration1766415256696
68	1767830400000	Migration1767830400000
69	1768306129179	Migration1768306129179
70	1768461678804	Migration1768461678804
71	1768475454675	Migration1768475454675
72	1768485728153	Migration1768485728153
73	1768583941244	Migration1768583941244
74	1769516172576	Migration1769516172576
75	1769516172577	Migration1769516172577
76	1770043707083	Migration1770043707083
77	1770212429837	Migration1770212429837
78	1770823569571	Migration1770823569571
79	1770880371265	Migration1770880371265
80	1770880371266	Migration1770880371266
81	1770900000000	Migration1770900000000
82	1773744656413	Migration1773744656413
83	1773916204375	Migration1773916204375
84	1774438866001	Migration1774438866001
85	1774438866002	Migration1774438866002
86	1774454790153	Migration1774454790153
87	1774454800508	Migration1774454800508
88	1778751201300	Migration1778751201300
\.


--
-- Name: migrations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.migrations_id_seq', 88, true);


--
-- PostgreSQL database dump complete
--

\unrestrict BQt8nysWhOJA0csJpDgcEcy2TU3Z3SwOQna9axHduJbY5znGJ2pgEegmgJdv7Pf

