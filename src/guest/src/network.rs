//! Network interface configuration for guest using rtnetlink
//!
//! Configures the guest's network interface to enable communication with the host.
//! The container inherits the guest's network namespace, so this configuration
//! must happen before the container starts.
//!
//! Uses rtnetlink (pure Rust netlink library) - no dependency on `ip` command.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use futures::stream::TryStreamExt;
use std::net::Ipv4Addr;

/// Configure guest network interface
///
/// Sets up eth0 with static IP 192.168.127.2/24 to match the network backend's DHCP configuration.
/// This enables:
/// - Outbound connectivity from container → host
/// - Inbound port forwarding: host → network backend → eth0 → container
///
/// # Network Architecture
/// ```text
/// Host                 Network Backend      Guest (eth0)        Container
/// localhost:3001  →   192.168.127.2:3001   →  0.0.0.0:3001
/// ```
///
/// # Implementation
/// Uses rtnetlink (pure Rust) for network configuration via Linux netlink.
/// No dependency on `ip` command binary.
#[allow(dead_code)] // Will be used when network configuration is enabled
pub async fn configure_network() -> BoxliteResult<()> {
    use rtnetlink::new_connection;

    tracing::info!("🌐 Configuring network interface eth0 (using rtnetlink)");

    // Create netlink connection
    let (connection, handle, _) = new_connection().map_err(|e| {
        BoxliteError::Internal(format!("Failed to create netlink connection: {}", e))
    })?;

    // Spawn the netlink connection in the background
    tokio::spawn(connection);

    // 1. Find the loopback interface (lo) and bring it up
    tracing::debug!("  ↑ Bringing up loopback interface");
    let mut links = handle.link().get().match_name("lo".to_string()).execute();
    if let Some(link) = links
        .try_next()
        .await
        .map_err(|e| BoxliteError::Internal(format!("Failed to get lo interface: {}", e)))?
    {
        handle
            .link()
            .set(link.header.index)
            .up()
            .execute()
            .await
            .map_err(|e| BoxliteError::Internal(format!("Failed to bring up lo: {}", e)))?;
    }

    // 2. Find eth0 interface
    tracing::info!("  🔍 Finding eth0 interface");
    let mut links = handle.link().get().match_name("eth0".to_string()).execute();

    let link = links
        .try_next()
        .await
        .map_err(|e| BoxliteError::Internal(format!("Failed to get eth0 interface: {}", e)))?
        .ok_or_else(|| BoxliteError::Internal("eth0 interface not found".to_string()))?;

    let eth0_index = link.header.index;
    tracing::debug!("  ✓ Found eth0 with index {}", eth0_index);

    // 3. Bring up eth0
    tracing::info!("  ↑ Bringing up eth0");
    handle
        .link()
        .set(eth0_index)
        .up()
        .execute()
        .await
        .map_err(|e| BoxliteError::Internal(format!("Failed to bring up eth0: {}", e)))?;

    // 4. Assign IP address: 192.168.127.2/24
    tracing::info!("  📍 Assigning IP: 192.168.127.2/24");
    let ip_addr = Ipv4Addr::new(192, 168, 127, 2);

    handle
        .address()
        .add(eth0_index, ip_addr.into(), 24) // /24 prefix
        .execute()
        .await
        .or_else(|e| {
            // Ignore "File exists" error (address already assigned)
            if e.to_string().contains("File exists") {
                tracing::debug!("IP address already assigned (this is OK)");
                Ok(())
            } else {
                Err(e)
            }
        })
        .map_err(|e| BoxliteError::Internal(format!("Failed to assign IP address to eth0: {}", e)))?;

    // 5. Add default route via 192.168.127.1
    tracing::info!("  🚪 Setting default gateway: 192.168.127.1");
    let gateway = Ipv4Addr::new(192, 168, 127, 1);

    handle
        .route()
        .add()
        .v4()
        .gateway(gateway)
        .execute()
        .await
        .or_else(|e| {
            // Ignore "File exists" error (route already exists)
            if e.to_string().contains("File exists") {
                tracing::debug!("Default route already exists (this is OK)");
                Ok(())
            } else {
                Err(e)
            }
        })
        .map_err(|e| BoxliteError::Internal(format!("Failed to set default gateway: {}", e)))?;

    tracing::info!("✅ Network configured: eth0 is UP at 192.168.127.2/24");

    // 6. Verify configuration (optional, for debugging)
    if tracing::enabled!(tracing::Level::DEBUG) {
        tracing::debug!("Verifying eth0 configuration:");

        // List addresses on eth0
        let mut addrs = handle
            .address()
            .get()
            .set_link_index_filter(eth0_index)
            .execute();

        while let Some(addr) = addrs
            .try_next()
            .await
            .map_err(|e| BoxliteError::Internal(format!("Failed to get addresses: {}", e)))?
        {
            tracing::debug!("  Address: {:?}", addr);
        }
    }

    Ok(())
}

/// Configure network interface with explicit parameters.
///
/// This is the primary API used by Guest.Init handler.
///
/// # Arguments
/// * `interface` - Network interface name (e.g., "eth0")
/// * `ip` - Optional IP address with prefix (e.g., "192.168.127.2/24"). If None, skips IP assignment.
/// * `gateway` - Optional gateway address (e.g., "192.168.127.1"). If None, skips route setup.
pub async fn configure_network_from_config(
    interface: &str,
    ip: Option<&str>,
    gateway: Option<&str>,
) -> BoxliteResult<()> {
    use rtnetlink::new_connection;

    tracing::info!(
        "🌐 Configuring network interface {} (using rtnetlink)",
        interface
    );

    // Create netlink connection
    let (connection, handle, _) = new_connection().map_err(|e| {
        BoxliteError::Internal(format!("Failed to create netlink connection: {}", e))
    })?;

    // Spawn the netlink connection in the background
    tokio::spawn(connection);

    // 1. Find the loopback interface (lo) and bring it up
    tracing::debug!("  ↑ Bringing up loopback interface");
    let mut links = handle.link().get().match_name("lo".to_string()).execute();
    if let Some(link) = links
        .try_next()
        .await
        .map_err(|e| BoxliteError::Internal(format!("Failed to get lo interface: {}", e)))?
    {
        handle
            .link()
            .set(link.header.index)
            .up()
            .execute()
            .await
            .map_err(|e| BoxliteError::Internal(format!("Failed to bring up lo: {}", e)))?;
    }

    // 2. Find interface
    tracing::info!("  🔍 Finding {} interface", interface);
    let mut links = handle
        .link()
        .get()
        .match_name(interface.to_string())
        .execute();

    let link = links
        .try_next()
        .await
        .map_err(|e| {
            BoxliteError::Internal(format!("Failed to get {} interface: {}", interface, e))
        })?
        .ok_or_else(|| BoxliteError::Internal(format!("{} interface not found", interface)))?;

    let if_index = link.header.index;
    tracing::debug!("  ✓ Found {} with index {}", interface, if_index);

    // 3. Bring up interface
    tracing::info!("  ↑ Bringing up {}", interface);
    handle
        .link()
        .set(if_index)
        .up()
        .execute()
        .await
        .map_err(|e| BoxliteError::Internal(format!("Failed to bring up {}: {}", interface, e)))?;

    // 4. Assign IP address (if provided)
    if let Some(ip_str) = ip {
        // Parse IP/prefix (e.g., "192.168.127.2/24")
        let (ip_addr, prefix) = parse_ip_prefix(ip_str)?;

        tracing::info!("  📍 Assigning IP: {}/{}", ip_addr, prefix);

        handle
            .address()
            .add(if_index, ip_addr.into(), prefix)
            .execute()
            .await
            .or_else(|e| {
                if e.to_string().contains("File exists") {
                    tracing::debug!("IP address already assigned (this is OK)");
                    Ok(())
                } else {
                    Err(e)
                }
            })
            .map_err(|e| {
                BoxliteError::Internal(format!(
                    "Failed to assign IP address to {}: {}",
                    interface, e
                ))
            })?;
    }

    // 5. Add default route (if gateway provided)
    if let Some(gw_str) = gateway {
        let gw_addr: Ipv4Addr = gw_str.parse().map_err(|e| {
            BoxliteError::Internal(format!("Invalid gateway address '{}': {}", gw_str, e))
        })?;

        tracing::info!("  🚪 Setting default gateway: {}", gw_addr);

        handle
            .route()
            .add()
            .v4()
            .gateway(gw_addr)
            .execute()
            .await
            .or_else(|e| {
                if e.to_string().contains("File exists") {
                    tracing::debug!("Default route already exists (this is OK)");
                    Ok(())
                } else {
                    Err(e)
                }
            })
            .map_err(|e| BoxliteError::Internal(format!("Failed to set default gateway: {}", e)))?;
    }

    tracing::info!("✅ Network configured: {} is UP", interface);
    Ok(())
}

/// Parse IP address with optional prefix (e.g., "192.168.127.2/24" or "192.168.127.2")
fn parse_ip_prefix(ip_str: &str) -> BoxliteResult<(Ipv4Addr, u8)> {
    if let Some((ip_part, prefix_part)) = ip_str.split_once('/') {
        let ip_addr: Ipv4Addr = ip_part.parse().map_err(|e| {
            BoxliteError::Internal(format!("Invalid IP address '{}': {}", ip_part, e))
        })?;
        let prefix: u8 = prefix_part.parse().map_err(|e| {
            BoxliteError::Internal(format!("Invalid prefix '{}': {}", prefix_part, e))
        })?;
        Ok((ip_addr, prefix))
    } else {
        // Default to /24 if no prefix specified
        let ip_addr: Ipv4Addr = ip_str.parse().map_err(|e| {
            BoxliteError::Internal(format!("Invalid IP address '{}': {}", ip_str, e))
        })?;
        Ok((ip_addr, 24))
    }
}
