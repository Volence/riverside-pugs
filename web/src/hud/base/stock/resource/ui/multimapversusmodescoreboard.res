"Resource/UI/MultiMapVersusModeScoreboard.res"
{
	"multimap_vs_scoreboard"
	{
		"ControlName"		"CMultiMapVersusModeScoreboard"
		"fieldName"			"multimap_vs_scoreboard"
		"xpos"				"c-300"
		"ypos"				"50"
		"wide"				"600"
		"tall"				"380"
		"autoResize"		"0"
		"pinCorner"			"0"
		"visible"			"1"
		"enabled"			"1"
		"tabPosition"		"0"
		"PaintBackgroundType"	"2"
	}
	
	
	"BackgroundImage"
	{
		"ControlName"	"ScalableImagePanel"
		"fieldName"		"BackgroundImage"
		"xpos"			"0"
		"ypos"			"0"
		"wide"			"500" 
		"tall"			"380"
		"visible"		"1"
		"enabled"		"1"
		"scaleImage"	"1"	
		"image"			"../vgui/hud/ScalablePanel_bgBlack_outlineGrey"
		"zpos"			"-2"
		
		"src_corner_height"		"16"				// pixels inside the image
		"src_corner_width"		"16"
			
		"draw_corner_width"		"8"				// screen size of the corners ( and sides ), proportional
		"draw_corner_height" 	"8"	
	}
	
	"CampaignTitleLabel"
	{
		"ControlName"		"Label"
		"fieldName"			"CampaignTitleLabel"
		"xpos"				"25"
		"ypos"				"20"
		"wide"				"120"
		"tall"				"36"
		"autoResize"		"0"
		"pinCorner"			"0"
		"visible"			"1"
		"enabled"			"1"
		"wrap"				"1"
		"labelText"			""
		"textAlignment"		"east"
		"dulltext"			"0"
		"brighttext"		"0"
		"fgcolor_override"	"White"
		"font"				"MenuTitle"
	}
	
	"ChapterLabel"
	{
		"ControlName"		"Label"
		"fieldName"			"ChapterLabel"
		"xpos"				"25`"
		"ypos"				"60"
		"wide"				"120"
		"tall"				"24"
		"autoResize"		"0"
		"pinCorner"			"0"
		"visible"			"1"
		"enabled"			"1"
		"wrap"				"1"
		"labelText"			""
		"textAlignment"		"east"
		"dulltext"			"0"
		"brighttext"		"0"
		"fgcolor_override"	"White"
		"font"				"MenuTitle"
	}
	
	"CVersusModeScoreboard" 
	{
		"ControlName"	"CVersusModeScoreboard"
		"fieldName"		"VersusModeScoreboard"
		"xpos"			"135" [$ENGLISH]
		"xpos"			"140" [$!ENGLISH]
		"ypos"			"-20"
		"wide"			"354" [$ENGLISH]
		"wide"			"364" [$!ENGLISH]
		"tall"			"120"
		"visible"		"1"
		"enabled"		"1"
	}
	
	
	"Row1"
	{
		"ControlName"	"CMultiMapVersusModeScoreboardRow"
		"fieldName"		"Row1"
		"xpos"			"20"
		"ypos"			"100"
		"wide"			"450"
		"tall"			"32"
	}
	
	"Row2"
	{
		"ControlName"	"CMultiMapVersusModeScoreboardRow"
		"fieldName"		"Row2"
		"xpos"			"20"
		"ypos"			"140"
		"wide"			"450"
		"tall"			"32"
	}
	
	"Row3"
	{
		"ControlName"	"CMultiMapVersusModeScoreboardRow"
		"fieldName"		"Row3"
		"xpos"			"20"
		"ypos"			"180"
		"wide"			"450"
		"tall"			"32"		
	}
	
	"Row4"
	{
		"ControlName"	"CMultiMapVersusModeScoreboardRow"
		"fieldName"		"Row4"
		"xpos"			"20"
		"ypos"			"220"
		"wide"			"450"
		"tall"			"32"		
	}
	
	"Row5"
	{
		"ControlName"	"CMultiMapVersusModeScoreboardRow"
		"fieldName"		"Row5"
		"xpos"			"20"
		"ypos"			"260"
		"wide"			"450"
		"tall"			"32"		

	}

	"Divider"
	{
		"ControlName"	"ImagePanel"
		"fieldName"		"Divider"
		"xpos"			"20"
		"ypos"			"300"
		"wide"			"450"
		"tall"			"2"
		"autoResize"	"0"
		"pinCorner"		"0"
		"visible"		"1"
		"enabled"		"1"
		"tabPosition"	"0"
		"PaintBackgroundType"	"0"
		//"fillcolor_override"	"DarkGray"
		"fillcolor_override"	"Gray"
		"usetitlesafe"	"1"
	}

	"CampaignRow"
	{
		"ControlName"	"CMultiMapVersusModeScoreboardRow"
		"fieldName"		"CampaignRow"
		"xpos"			"20"
		"ypos"			"310"
		"wide"			"450"
		"tall"			"32"		
	}	
	
}
