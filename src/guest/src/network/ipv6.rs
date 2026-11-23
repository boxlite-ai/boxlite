use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use futures::stream::TryStreamExt;
use std::net::{IpAddr, Ipv6Addr};
use std::time::Duration;

use boxlite_shared::generated::GuestIpv6Check;
use netlink_packet_route::address::{AddressAttribute, AddressFlag};
use netlink_packet_route::route::{RouteAddress, RouteAttribute, RouteHeader, RouteType};

pub(crate) async fn confirm_ipv6(plan: &GuestIpv6Check, configure: bool) -> BoxliteResult<()> {
    let guest = plan.guest.parse::<Ipv6Addr>().map_err(ipv6_error)?;
    let gateway = plan.gateway.parse::<Ipv6Addr>().map_err(ipv6_error)?;
    let guest_bits = u128::from(guest);
    let gateway_bits = u128::from(gateway);
    if plan.interface != "eth0"
        || plan.epoch.is_empty()
        || guest_bits >> 120 != 0xfd
        || guest_bits >> 64 != gateway_bits >> 64
        || guest_bits as u64 == 0
        || gateway_bits as u64 == 0
        || guest == gateway
    {
        return Err(ipv6_error("invalid link plan"));
    }
    let (connection, handle, _) = rtnetlink::new_connection().map_err(ipv6_error)?;
    let task = tokio::spawn(connection);
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        confirm_ipv6_link(&handle, &plan.interface, guest, gateway, configure),
    )
    .await;
    task.abort();
    result.map_err(ipv6_error)?
}

fn ipv6_error(error: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Network(format!("Guest IPv6 link: {error}"))
}

async fn confirm_ipv6_link(
    handle: &rtnetlink::Handle,
    interface: &str,
    guest: Ipv6Addr,
    gateway: Ipv6Addr,
    configure: bool,
) -> BoxliteResult<()> {
    let interface = handle
        .link()
        .get()
        .match_name(interface.into())
        .execute()
        .try_next()
        .await
        .map_err(ipv6_error)?
        .ok_or_else(|| ipv6_error("interface is absent"))?;
    let index = interface.header.index;
    let address = IpAddr::V6(guest);
    if configure {
        tokio::fs::write("/proc/sys/net/ipv6/conf/eth0/accept_ra", "0")
            .await
            .map_err(ipv6_error)?;
        tokio::fs::write("/proc/sys/net/ipv6/conf/eth0/accept_dad", "1")
            .await
            .map_err(ipv6_error)?;
        tokio::fs::write("/proc/sys/net/ipv6/conf/eth0/dad_transmits", "1")
            .await
            .map_err(ipv6_error)?;
        handle
            .address()
            .add(index, address, 64)
            .execute()
            .await
            .map_err(ipv6_error)?;
    }

    loop {
        let mut addresses = handle
            .address()
            .get()
            .set_link_index_filter(index)
            .execute();
        let mut match_state = None;
        while let Some(entry) = addresses.try_next().await.map_err(ipv6_error)? {
            if entry.header.prefix_len != 64
                || !entry
                    .attributes
                    .contains(&AddressAttribute::Address(address))
            {
                continue;
            }
            let header_flags = entry
                .header
                .flags
                .iter()
                .fold(0u32, |flags, entry| flags | u32::from(u8::from(*entry)));
            let flags = entry
                .attributes
                .iter()
                .filter_map(|attribute| match attribute {
                    AddressAttribute::Flags(flags) => Some(flags.as_slice()),
                    _ => None,
                })
                .flatten()
                .fold(header_flags, |bits, flag| bits | u32::from(*flag));
            if flags & (u32::from(AddressFlag::Dadfailed) | u32::from(AddressFlag::Nodad)) != 0 {
                return Err(ipv6_error("address failed duplicate address detection"));
            }
            match_state = Some(flags & u32::from(AddressFlag::Tentative) == 0);
            break;
        }
        match match_state {
            Some(true) => break,
            Some(false) if configure => tokio::time::sleep(Duration::from_millis(50)).await,
            _ => return Err(ipv6_error("planned address is absent or tentative")),
        }
    }
    if configure {
        handle
            .route()
            .add()
            .v6()
            .gateway(gateway)
            .output_interface(index)
            .execute()
            .await
            .map_err(ipv6_error)?;
    }
    let mut routes = handle.route().get(rtnetlink::IpVersion::V6).execute();
    let mut matched = false;
    while let Some(route) = routes.try_next().await.map_err(ipv6_error)? {
        if route.header.destination_prefix_length != 0
            || route.header.table != RouteHeader::RT_TABLE_MAIN
            || route.header.kind != RouteType::Unicast
        {
            continue;
        }
        if matched
            || !route.attributes.contains(&RouteAttribute::Oif(index))
            || !route
                .attributes
                .contains(&RouteAttribute::Gateway(RouteAddress::Inet6(gateway)))
        {
            return Err(ipv6_error("unexpected IPv6 default route"));
        }
        matched = true;
    }
    if !matched {
        return Err(ipv6_error("planned IPv6 default route is absent"));
    }
    Ok(())
}
