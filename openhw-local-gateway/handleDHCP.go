package main

import (
	"fmt"
	"net"
	"sync"

	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
	"github.com/gorilla/websocket"
	"github.com/insomniacslk/dhcp/dhcpv4"
)

var (
	globalNextIP byte = 2
	globalMacToIP = make(map[string]net.IP)
	dhcpMutex sync.Mutex
)

// handleDHCP processes DHCP Discover/Request packets, assigns an IP, and sends an Offer/ACK directly back to the client.
func handleDHCP(msg []byte, packet gopacket.Packet, client *Client, room *Room) {
	fmt.Println("\n[DHCP] --- Intercepted UDP Port 67 Packet! ---")
	ethLayer := packet.Layer(layers.LayerTypeEthernet)
	if ethLayer == nil {
		fmt.Println("[DHCP] Error: No Ethernet Layer found.")
		return
	}
	eth, _ := ethLayer.(*layers.Ethernet)
	
	udpLayer := packet.Layer(layers.LayerTypeUDP)
	if udpLayer == nil {
		fmt.Println("[DHCP] Error: No UDP Layer found.")
		return
	}
	udp, _ := udpLayer.(*layers.UDP)

	dhcpPacket, err := dhcpv4.FromBytes(udp.Payload)
	if err != nil {
		fmt.Printf("[DHCP] Error parsing DHCP: %v\n", err)
		return
	}

	macString := eth.SrcMAC.String()
	
	dhcpMutex.Lock()
	assignedIP, exists := globalMacToIP[macString]
	if !exists {
		assignedIP = net.IPv4(192, 168, 127, globalNextIP)
		globalNextIP++
		if globalNextIP > 250 {
			globalNextIP = 2
		}
		globalMacToIP[macString] = assignedIP
	}
	dhcpMutex.Unlock()

	var replyDHCP *dhcpv4.DHCPv4
	serverIP := net.IPv4(192, 168, 127, 1)
	routerIP := net.IPv4(192, 168, 127, 1)
	dnsIP := net.IPv4(8, 8, 8, 8)
	netmask := net.IPv4Mask(255, 255, 255, 0)

	msgType := dhcpPacket.MessageType()
	if msgType == dhcpv4.MessageTypeDiscover {
		fmt.Printf("[DHCP] Intercepted DISCOVER from %s. Offering %s\n", macString, assignedIP)
		replyDHCP, _ = dhcpv4.NewReplyFromRequest(dhcpPacket,
			dhcpv4.WithMessageType(dhcpv4.MessageTypeOffer),
			dhcpv4.WithYourIP(assignedIP),
			dhcpv4.WithServerIP(serverIP),
			dhcpv4.WithOption(dhcpv4.OptServerIdentifier(serverIP)),
			dhcpv4.WithRouter(routerIP),
			dhcpv4.WithDNS(dnsIP),
			dhcpv4.WithNetmask(netmask),
			dhcpv4.WithLeaseTime(86400),
		)
	} else if msgType == dhcpv4.MessageTypeRequest {
		fmt.Printf("[DHCP] Intercepted REQUEST from %s. Acknowledging %s\n", macString, assignedIP)
		replyDHCP, _ = dhcpv4.NewReplyFromRequest(dhcpPacket,
			dhcpv4.WithMessageType(dhcpv4.MessageTypeAck),
			dhcpv4.WithYourIP(assignedIP),
			dhcpv4.WithServerIP(serverIP),
			dhcpv4.WithOption(dhcpv4.OptServerIdentifier(serverIP)),
			dhcpv4.WithRouter(routerIP),
			dhcpv4.WithDNS(dnsIP),
			dhcpv4.WithNetmask(netmask),
			dhcpv4.WithLeaseTime(86400),
		)
	} else {
		return
	}

	ethReply := &layers.Ethernet{
		SrcMAC:       net.HardwareAddr{0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd},
		DstMAC:       net.HardwareAddr{0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, // Broadcast MAC for DHCP Reply
		EthernetType: layers.EthernetTypeIPv4,
	}
	ipv4Reply := &layers.IPv4{
		Version:  4,
		IHL:      5,
		TTL:      64,
		Protocol: layers.IPProtocolUDP,
		SrcIP:    serverIP,
		DstIP:    net.IPv4(255, 255, 255, 255), // Broadcast IP
	}
	udpReply := &layers.UDP{
		SrcPort: 67,
		DstPort: 68,
	}
	udpReply.SetNetworkLayerForChecksum(ipv4Reply)

	buffer := gopacket.NewSerializeBuffer()
	options := gopacket.SerializeOptions{
		ComputeChecksums: true,
		FixLengths:       true,
	}
	gopacket.SerializeLayers(buffer, options,
		ethReply,
		ipv4Reply,
		udpReply,
		gopacket.Payload(replyDHCP.ToBytes()),
	)

	replyMsg := buffer.Bytes()

	fmt.Printf("[DHCP] Sending %d byte reply back to client MAC: %s\n", len(replyMsg), eth.SrcMAC.String())

	client.WriteMutex.Lock()
	client.Conn.WriteMessage(websocket.BinaryMessage, replyMsg)
	client.WriteMutex.Unlock()
}
