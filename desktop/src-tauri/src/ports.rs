use std::io;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

#[derive(Debug)]
pub struct LoopbackPortReservation {
    listener: TcpListener,
}

impl LoopbackPortReservation {
    pub fn reserve() -> io::Result<Self> {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
        Ok(Self { listener })
    }

    pub fn port(&self) -> io::Result<u16> {
        Ok(self.listener.local_addr()?.port())
    }

    pub fn release(self) -> u16 {
        self.listener
            .local_addr()
            .expect("a bound loopback listener must have an address")
            .port()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_a_port_on_loopback_only() {
        let reservation = LoopbackPortReservation::reserve().unwrap();
        let address = reservation.listener.local_addr().unwrap();

        assert!(address.ip().is_loopback());
        assert_ne!(reservation.port().unwrap(), 0);
    }

    #[test]
    fn keeps_the_port_exclusive_until_release() {
        let reservation = LoopbackPortReservation::reserve().unwrap();
        let port = reservation.port().unwrap();

        assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_err());
        reservation.release();
        assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok());
    }
}
